// Import-time canary: a scanner that imported this module would write EXECUTED.txt and throw.
import { writeFileSync } from 'node:fs';

writeFileSync(new URL('./EXECUTED.txt', import.meta.url), 'executed');
throw new Error('never imported by the scanner');
