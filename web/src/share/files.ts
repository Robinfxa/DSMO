// The on-device engine's own files a share touches (skills, AGENTS.md, the
// restore point safe mode can undo), through the app-local bridge — DSH has no
// Remote for them (bridge_local.dart `share.*`).

import { local } from '../bridge/native';
import type { SharedSkill } from './models';

export interface LocalSkill {
  name: string;
  description?: string;
  files: Record<string, string>;
}

export const readLocalFiles = () => local<{ skills: LocalSkill[]; agentsMd: string | null }>('share.localFiles');
export const readSkill = (name: string) => local<Record<string, string> | null>('share.readSkill', { name });
export const readImportedAgentsMd = () => local<string | null>('share.readAgentsMd');
export const pinRestorePoint = () => local<boolean>('share.pinRestorePoint');
export const writeSkill = (skill: SharedSkill) => local<void>('share.writeSkill', { skill });
export const writeAgentsMd = (text: string) => local<void>('share.writeAgentsMd', { text });
