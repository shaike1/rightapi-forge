import fs from 'fs';
import path from 'path';

export interface FactoryBoardItem {
  title: string;
  details: string[];
  refs: string[];
}

export interface FactoryBoardSnapshot {
  sourcePath: string;
  sourceExists: boolean;
  loadedAt: string;
  boardLastUpdated: string | null;
  phaseMap: string[];
  live: {
    activePhase: string | null;
    activeTrack: string | null;
    platformStatus: string | null;
  };
  columns: {
    done: FactoryBoardItem[];
    inProgress: FactoryBoardItem[];
    next: FactoryBoardItem[];
    backlog: FactoryBoardItem[];
  };
  workingFeatures: string[];
}

function parseRefs(input: string): string[] {
  const refs: string[] = [];
  const regex = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    if (match[1]) refs.push(match[1]);
  }
  return refs;
}

function tryDefaultBoardPaths(): string[] {
  return [
    process.env.FACTORY_BOARD_PATH || '',
    path.join(process.cwd(), 'PROJECT_KANBAN.md'),
    '/data/itops-agents/PROJECT_KANBAN.md'
  ].filter(Boolean);
}

export class FactoryBoardService {
  private boardPath: string;

  constructor(boardPath?: string) {
    this.boardPath = boardPath || tryDefaultBoardPaths()[0];
  }

  resolvePath(): string {
    if (this.boardPath && fs.existsSync(this.boardPath)) return this.boardPath;
    const match = tryDefaultBoardPaths().find(candidate => fs.existsSync(candidate));
    return match || this.boardPath || path.join(process.cwd(), 'PROJECT_KANBAN.md');
  }

  getSnapshot(): FactoryBoardSnapshot {
    const sourcePath = this.resolvePath();
    const sourceExists = !!sourcePath && fs.existsSync(sourcePath);
    const snapshot: FactoryBoardSnapshot = {
      sourcePath,
      sourceExists,
      loadedAt: new Date().toISOString(),
      boardLastUpdated: null,
      phaseMap: [],
      live: {
        activePhase: null,
        activeTrack: null,
        platformStatus: null
      },
      columns: {
        done: [],
        inProgress: [],
        next: [],
        backlog: []
      },
      workingFeatures: []
    };
    if (!sourceExists) return snapshot;

    const lines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);
    let section: '' | 'phase_map' | 'live_snapshot' | 'done' | 'in_progress' | 'next' | 'backlog' | 'working_features' = '';
    let currentItem: FactoryBoardItem | null = null;

    const pushCurrentItem = (): void => {
      if (!currentItem) return;
      if (section === 'done') snapshot.columns.done.push(currentItem);
      if (section === 'in_progress') snapshot.columns.inProgress.push(currentItem);
      if (section === 'next') snapshot.columns.next.push(currentItem);
      if (section === 'backlog') snapshot.columns.backlog.push(currentItem);
      currentItem = null;
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      const trimmed = line.trim();
      const normalizedHeading = /^-\s*#{2,3}\s+/.test(trimmed)
        ? trimmed.replace(/^-\s*/, '')
        : trimmed;
      if (!trimmed) continue;

      if (trimmed.startsWith('Last updated:')) {
        snapshot.boardLastUpdated = trimmed.slice('Last updated:'.length).trim() || null;
        continue;
      }
      if (normalizedHeading === '## Phase Map') {
        pushCurrentItem();
        section = 'phase_map';
        continue;
      }
      if (normalizedHeading === '## Live Snapshot') {
        pushCurrentItem();
        section = 'live_snapshot';
        continue;
      }
      if (normalizedHeading === '### Done') {
        pushCurrentItem();
        section = 'done';
        continue;
      }
      if (normalizedHeading === '### In Progress') {
        pushCurrentItem();
        section = 'in_progress';
        continue;
      }
      if (normalizedHeading === '### Next') {
        pushCurrentItem();
        section = 'next';
        continue;
      }
      if (normalizedHeading === '### Backlog') {
        pushCurrentItem();
        section = 'backlog';
        continue;
      }
      if (normalizedHeading === '## Working Features (Operator-Visible)') {
        pushCurrentItem();
        section = 'working_features';
        continue;
      }
      if (normalizedHeading.startsWith('## ') || normalizedHeading.startsWith('### ')) {
        pushCurrentItem();
        section = '';
        continue;
      }

      if (section === 'phase_map' && trimmed.startsWith('- ')) {
        snapshot.phaseMap.push(trimmed.slice(2).trim());
        continue;
      }
      if (section === 'live_snapshot' && trimmed.startsWith('- ')) {
        if (trimmed.toLowerCase().startsWith('- current active phase:')) {
          snapshot.live.activePhase = trimmed.split(':').slice(1).join(':').replace(/\*\*/g, '').trim();
        } else if (trimmed.toLowerCase().startsWith('- current active track:')) {
          snapshot.live.activeTrack = trimmed.split(':').slice(1).join(':').replace(/\*\*/g, '').trim();
        } else if (trimmed.toLowerCase().startsWith('- platform status:')) {
          snapshot.live.platformStatus = trimmed.split(':').slice(1).join(':').replace(/\*\*/g, '').trim();
        }
        continue;
      }

      if (section === 'working_features' && trimmed.startsWith('- ')) {
        snapshot.workingFeatures.push(trimmed.slice(2).trim());
        continue;
      }

      const inColumn = ['done', 'in_progress', 'next', 'backlog'].includes(section);
      if (!inColumn) continue;

      const isTopBullet = line.startsWith('- ');
      const isNestedBullet = line.startsWith('  - ');
      if (isTopBullet) {
        pushCurrentItem();
        const title = trimmed.slice(2).trim();
        currentItem = {
          title,
          details: [],
          refs: parseRefs(title)
        };
        continue;
      }
      if (isNestedBullet && currentItem) {
        const detail = trimmed.slice(2).trim();
        currentItem.details.push(detail);
        currentItem.refs.push(...parseRefs(detail));
      }
    }
    pushCurrentItem();

    const dedupe = (arr: string[]) => Array.from(new Set(arr));
    snapshot.columns.done.forEach(item => { item.refs = dedupe(item.refs); });
    snapshot.columns.inProgress.forEach(item => { item.refs = dedupe(item.refs); });
    snapshot.columns.next.forEach(item => { item.refs = dedupe(item.refs); });
    snapshot.columns.backlog.forEach(item => { item.refs = dedupe(item.refs); });
    return snapshot;
  }
}
