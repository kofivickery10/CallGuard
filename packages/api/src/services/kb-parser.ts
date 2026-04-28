const MAX_EXTRACTED_CHARS = 50_000;

export async function parseFileToText(
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  let text: string;

  switch (mimeType) {
    case 'application/pdf': {
      // @ts-expect-error - pdf-parse has no types shipped
      const pdfParse = (await import('pdf-parse')).default;
      const result = await pdfParse(buffer);
      text = result.text;
      break;
    }

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/msword': {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
      break;
    }

    case 'text/plain':
    case 'text/markdown':
      text = buffer.toString('utf-8');
      break;

    default:
      throw new Error(`Unsupported file type: ${mimeType}`);
  }

  // Normalise whitespace and truncate
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_EXTRACTED_CHARS) {
    text = text.slice(0, MAX_EXTRACTED_CHARS) + '\n\n[...truncated...]';
  }

  return text;
}
