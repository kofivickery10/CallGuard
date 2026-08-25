// Run a candidate parse config against a document's extracted text.
//
// Designing a format means guessing at a config and looking at what comes out.
// Doing that through the live pipeline costs a CRM download and a job per
// attempt; doing it here costs nothing and touches nothing — no database, no
// network. Pair it with dump-sale-documents.ts.
//
// Usage:
//   tsx src/scripts/try-parse-config.ts <text-file> <strategy> <config.json>
//   tsx src/scripts/try-parse-config.ts doc.txt label_value config.json --full
import { readFile } from 'node:fs/promises';
import { parseApplication, parseLooksHealthy, type ParseConfig, type ParseStrategy } from '../services/application-pdf.js';
import { auditQuestionSet, proposalIsUsable } from '../services/question-quality.js';

const STRATEGIES: ParseStrategy[] = ['question_answer', 'label_value', 'question_marker'];

async function main(): Promise<void> {
  const [textFile, strategyArg, configFile] = process.argv.slice(2);
  const full = process.argv.includes('--full');
  if (!textFile || !strategyArg || !configFile) {
    console.log('Usage: tsx src/scripts/try-parse-config.ts <text-file> <strategy> <config.json> [--full]');
    return;
  }
  if (!STRATEGIES.includes(strategyArg as ParseStrategy)) {
    console.log(`strategy must be one of ${STRATEGIES.join(', ')}`);
    return;
  }

  const text = await readFile(textFile, 'utf8');
  const config = JSON.parse(await readFile(configFile, 'utf8')) as ParseConfig;
  const parsed = parseApplication(text, strategyArg as ParseStrategy, config);

  const audit = auditQuestionSet(parsed.pairs.map((p) => p.question));
  console.log(
    `${parsed.pairs.length} pair(s)  empty=${parsed.empty}  fingerprint ${parsed.fingerprint.slice(0, 16)}\n` +
      `mangled ${audit.corrupt.length}/${audit.total}  ` +
      `usable=${proposalIsUsable(parsed.pairs.map((p) => p.question))}` +
      (parseLooksHealthy(parsed) ? `\n! parseLooksHealthy: ${parseLooksHealthy(parsed)}` : '')
  );

  for (const pair of parsed.pairs) {
    const flags = audit.corrupt.find((c) => c.question === pair.question);
    console.log(
      `\n${String(pair.order).padStart(3)}. ${flags ? '! ' : ''}${pair.question}` +
        (flags ? `   [${flags.flags.map((f) => f.name).join(', ')}]` : '')
    );
    const answer = pair.answer === null ? '(no answer)' : full ? pair.answer : pair.answer.slice(0, 160);
    console.log(`     => ${answer}`);
    if (full && pair.guidance) console.log(`     guidance: ${pair.guidance}`);
    if (full && pair.choices.length) console.log(`     choices: ${JSON.stringify(pair.choices)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
