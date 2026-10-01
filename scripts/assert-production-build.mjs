import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const forbidden = [
  path.join(root, 'dist', 'test'),
  path.join(root, 'dist', 'src', 'desktop', 'native-first-thread-start-harness.js'),
  path.join(root, 'dist', 'src', 'desktop', 'native-first-turn-dispatch-harness.js'),
];
if (forbidden.some(file => existsSync(file))) {
  throw new Error('Production build contains test-only native RPC harness output');
}
