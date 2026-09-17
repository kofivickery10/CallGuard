/**
 * Every data source the ops server knows about, in build order (CG-55).
 *
 * A source is a plain object:
 *   id, title    — how it appears in the health report
 *   env          — the variables it needs: { name, description, secret?, file?, optional? }
 *                  `secret` values are redacted from all tool output;
 *                  `file` values are paths checked by the health tool
 *   register     — (defineTool, env) => void, adding its read-only tools;
 *                  null until the source is built
 *
 * Adding a source: fill in its file, set `register`, and list any new
 * variables in .env.example.
 */
import database from './database.js';
import anthropic from './anthropic.js';
import deepgram from './deepgram.js';
import searchConsole from './search-console.js';
import analytics from './analytics.js';
import companiesHouse from './companies-house.js';
import fcaRegister from './fca-register.js';

export const SOURCES = [database, anthropic, deepgram, searchConsole, analytics, companiesHouse, fcaRegister];
