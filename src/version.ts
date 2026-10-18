import { readFileSync } from 'node:fs';

export const TOOL_NAME = 'dataverse-plugins-native';
// Compiled modules live in dist/src; package.json is the release version source.
export const TOOL_VERSION: string = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
