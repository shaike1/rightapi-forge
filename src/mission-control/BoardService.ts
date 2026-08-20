// Board and BoardGroup management service for Mission Control integration

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import type {
  Board,
  BoardGroup,
  BoardStatus,
  BoardGroupStatus,
  Task
} from '../types/index.js';

export class BoardService {
  private boards: Map<string, Board> = new Map();
  private boardGroups: Map<string, BoardGroup> = new Map();
  private dataDir: string;
  private organizationName: string;

  constructor(organizationName: string, dataDir: string = './data/boards') {
    this.organizationName = organizationName;
    this.dataDir = dataDir;
    this.ensureDataDir();
    this.load();
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private getDataPath(): string {
    return path.join(this.dataDir, `${this.sanitizeName(this.organizationName)}.json`);
  }

  private sanitizeName(name: string): string {
    return name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  }

  // BoardGroup operations

  createBoardGroup(name: string, description?: string): BoardGroup {
    const group: BoardGroup = {
      id: uuidv4(),
      name,
      description,
      organizationName: this.organizationName,
      status: 'active',
      boardIds: [],
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.boardGroups.set(group.id, group);
    this.save();
    return group;
  }

  getBoardGroup(id: string): BoardGroup | undefined {
    return this.boardGroups.get(id);
  }

  getAllBoardGroups(): BoardGroup[] {
    return Array.from(this.boardGroups.values());
  }

  getActiveBoardGroups(): BoardGroup[] {
    return Array.from(this.boardGroups.values()).filter(g => g.status === 'active');
  }

  updateBoardGroup(id: string, updates: Partial<Omit<BoardGroup, 'id' | 'createdAt'>>): BoardGroup | null {
    const group = this.boardGroups.get(id);
    if (!group) return null;

    const updated = {
      ...group,
      ...updates,
      updatedAt: new Date()
    };
    this.boardGroups.set(id, updated);
    this.save();
    return updated;
  }

  archiveBoardGroup(id: string): boolean {
    const group = this.boardGroups.get(id);
    if (!group) return false;

    group.status = 'archived';
    group.updatedAt = new Date();
    this.save();
    return true;
  }

  deleteBoardGroup(id: string): boolean {
    // First unarchive any boards in this group
    const group = this.boardGroups.get(id);
    if (!group) return false;

    for (const boardId of group.boardIds) {
      const board = this.boards.get(boardId);
      if (board) {
        board.groupId = undefined;
        board.updatedAt = new Date();
      }
    }

    this.boardGroups.delete(id);
    this.save();
    return true;
  }

  // Board operations

  createBoard(
    name: string,
    ownerId: string,
    options?: {
      description?: string;
      groupId?: string;
      tags?: string[];
      taskIds?: string[];
      settings?: Board['settings'];
    }
  ): Board {
    const board: Board = {
      id: uuidv4(),
      name,
      description: options?.description,
      groupId: options?.groupId,
      status: 'active',
      taskIds: options?.taskIds || [],
      tags: options?.tags || [],
      ownerId,
      createdAt: new Date(),
      updatedAt: new Date(),
      settings: options?.settings
    };

    this.boards.set(board.id, board);

    // Add to board group if specified
    if (board.groupId) {
      const group = this.boardGroups.get(board.groupId);
      if (group && !group.boardIds.includes(board.id)) {
        group.boardIds.push(board.id);
        group.updatedAt = new Date();
      }
    }

    this.save();
    return board;
  }

  getBoard(id: string): Board | undefined {
    return this.boards.get(id);
  }

  getAllBoards(): Board[] {
    return Array.from(this.boards.values());
  }

  getActiveBoards(): Board[] {
    return Array.from(this.boards.values()).filter(b => b.status === 'active');
  }

  getBoardsByGroup(groupId: string): Board[] {
    return Array.from(this.boards.values()).filter(b => b.groupId === groupId);
  }

  getBoardsByOwner(ownerId: string): Board[] {
    return Array.from(this.boards.values()).filter(b => b.ownerId === ownerId);
  }

  getBoardsByTag(tag: string): Board[] {
    return Array.from(this.boards.values()).filter(b => b.tags.includes(tag));
  }

  updateBoard(id: string, updates: Partial<Omit<Board, 'id' | 'createdAt'>>): Board | null {
    const board = this.boards.get(id);
    if (!board) return null;

    const updated = {
      ...board,
      ...updates,
      updatedAt: new Date()
    };
    this.boards.set(id, updated);
    this.save();
    return updated;
  }

  addTaskToBoard(boardId: string, taskId: string): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;

    if (!board.taskIds.includes(taskId)) {
      board.taskIds.push(taskId);
      board.updatedAt = new Date();
      this.save();
    }
    return true;
  }

  removeTaskFromBoard(boardId: string, taskId: string): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;

    board.taskIds = board.taskIds.filter(id => id !== taskId);
    board.updatedAt = new Date();
    this.save();
    return true;
  }

  addTagToBoard(boardId: string, tag: string): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;

    if (!board.tags.includes(tag)) {
      board.tags.push(tag);
      board.updatedAt = new Date();
      this.save();
    }
    return true;
  }

  removeTagFromBoard(boardId: string, tag: string): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;

    board.tags = board.tags.filter(t => t !== tag);
    board.updatedAt = new Date();
    this.save();
    return true;
  }

  archiveBoard(id: string): boolean {
    const board = this.boards.get(id);
    if (!board) return false;

    board.status = 'archived';
    board.updatedAt = new Date();
    this.save();
    return true;
  }

  lockBoard(id: string): boolean {
    const board = this.boards.get(id);
    if (!board) return false;

    board.status = 'locked';
    board.updatedAt = new Date();
    this.save();
    return true;
  }

  unlockBoard(id: string): boolean {
    const board = this.boards.get(id);
    if (!board) return false;

    if (board.status === 'locked') {
      board.status = 'active';
      board.updatedAt = new Date();
      this.save();
    }
    return true;
  }

  deleteBoard(id: string): boolean {
    const board = this.boards.get(id);
    if (!board) return false;

    // Remove from board group
    if (board.groupId) {
      const group = this.boardGroups.get(board.groupId);
      if (group) {
        group.boardIds = group.boardIds.filter(bid => bid !== id);
        group.updatedAt = new Date();
      }
    }

    this.boards.delete(id);
    this.save();
    return true;
  }

  // Get all tags used across boards
  getAllTags(): string[] {
    const tags = new Set<string>();
    for (const board of this.boards.values()) {
      for (const tag of board.tags) {
        tags.add(tag);
      }
    }
    return Array.from(tags).sort();
  }

  // Get statistics
  getStats(): {
    totalBoards: number;
    activeBoards: number;
    archivedBoards: number;
    lockedBoards: number;
    totalBoardGroups: number;
    activeBoardGroups: number;
    totalTasks: number;
    uniqueTags: number;
  } {
    const boards = Array.from(this.boards.values());
    const groups = Array.from(this.boardGroups.values());
    const tags = this.getAllTags();

    return {
      totalBoards: boards.length,
      activeBoards: boards.filter(b => b.status === 'active').length,
      archivedBoards: boards.filter(b => b.status === 'archived').length,
      lockedBoards: boards.filter(b => b.status === 'locked').length,
      totalBoardGroups: groups.length,
      activeBoardGroups: groups.filter(g => g.status === 'active').length,
      totalTasks: boards.reduce((sum, b) => sum + b.taskIds.length, 0),
      uniqueTags: tags.length
    };
  }

  // Persistence
  save(): void {
    const data = {
      version: 1,
      organizationName: this.organizationName,
      boards: Array.from(this.boards.entries()),
      boardGroups: Array.from(this.boardGroups.entries())
    };

    fs.writeFileSync(this.getDataPath(), JSON.stringify(data, null, 2), 'utf8');
  }

  load(): boolean {
    const dataPath = this.getDataPath();
    if (!fs.existsSync(dataPath)) {
      return false;
    }

    try {
      const content = fs.readFileSync(dataPath, 'utf8');
      const data = JSON.parse(content);

      this.organizationName = data.organizationName || this.organizationName;
      this.boards = new Map(data.boards || []);
      this.boardGroups = new Map(data.boardGroups || []);

      return true;
    } catch (error) {
      logger.error('Failed to load boards:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      return false;
    }
  }

  // Export/Import
  export(): string {
    const data = {
      version: 1,
      organizationName: this.organizationName,
      boards: Array.from(this.boards.entries()),
      boardGroups: Array.from(this.boardGroups.entries()),
      exportedAt: new Date().toISOString()
    };
    return JSON.stringify(data, null, 2);
  }

  import(jsonData: string, mode: 'merge' | 'replace' = 'merge'): { success: boolean; imported: number; errors?: string[] } {
    const errors: string[] = [];
    let imported = 0;

    try {
      const data = JSON.parse(jsonData);

      if (data.version !== 1) {
        return { success: false, imported: 0, errors: ['Invalid version'] };
      }

      if (mode === 'replace') {
        this.boards.clear();
        this.boardGroups.clear();
      }

      // Import board groups
      for (const [id, group] of data.boardGroups || []) {
        try {
          if (!this.boardGroups.has(id)) {
            this.boardGroups.set(id, group);
            imported++;
          }
        } catch (e) {
          errors.push(`Failed to import board group ${id}: ${e}`);
        }
      }

      // Import boards
      for (const [id, board] of data.boards || []) {
        try {
          if (!this.boards.has(id)) {
            this.boards.set(id, board);
            imported++;
          }
        } catch (e) {
          errors.push(`Failed to import board ${id}: ${e}`);
        }
      }

      this.save();

      return {
        success: true,
        imported,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error) {
      return {
        success: false,
        imported: 0,
        errors: [`Failed to parse JSON: ${error}`]
      };
    }
  }
}
