// API Keys management with persistent storage

import express, { type Request, type Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger.js';

const router = express.Router();

const API_KEYS_FILE = process.env.API_KEYS_PATH || '/data/itops-agents/api-keys.json';

interface ApiKeyRecord {
  provider: string;
  key: string;
  baseUrl?: string;
  groupId?: string;
  createdAt: string;
  enabled: boolean;
}

interface ApiKeysStore {
  version: number;
  keys: Record<string, ApiKeyRecord>;
}

// In-memory cache
let apiKeysCache: Record<string, ApiKeyRecord> = {};

// Load keys from file
function loadKeys(): void {
  try {
    if (fs.existsSync(API_KEYS_FILE)) {
      const data = fs.readFileSync(API_KEYS_FILE, 'utf8');
      const store = JSON.parse(data) as ApiKeysStore;
      apiKeysCache = store.keys || {};
      logger.info('Loaded API keys:', { count: Object.keys(apiKeysCache).length });
    }
  } catch (error) {
    logger.error('Failed to load API keys:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    apiKeysCache = {};
  }
}

// Save keys to file
function saveKeys(): void {
  try {
    const dir = path.dirname(API_KEYS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const store: ApiKeysStore = {
      version: 1,
      keys: apiKeysCache
    };
    fs.writeFileSync(API_KEYS_FILE, JSON.stringify(store, null, 2));
  } catch (error) {
    logger.error('Failed to save API keys:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  }
}

// Initialize
loadKeys();

// Get all keys (masked)
router.get('/', (_req: Request, res: Response) => {
  const keys = Object.entries(apiKeysCache).map(([id, record]) => ({
    id,
    provider: record.provider,
    baseUrl: record.baseUrl,
    createdAt: record.createdAt,
    enabled: record.enabled,
    key: record.key ? `${record.key.substring(0, 8)}...${record.key.substring(record.key.length - 4)}` : ''
  }));
  res.json({ success: true, keys });
});

// Get single key (unmasked - for internal use)
router.get('/:provider', (req: Request, res: Response) => {
  const provider = req.params.provider;
  const key = Object.entries(apiKeysCache).find(([id, record]) => 
    record.provider === provider && record.enabled
  );
  
  if (key) {
    res.json({ 
      success: true, 
      provider: key[1].provider,
      key: key[1].key,
      baseUrl: key[1].baseUrl,
      groupId: key[1].groupId
    });
  } else {
    res.json({ success: false, error: 'Provider not configured' });
  }
});

// Add or update key
router.post('/', (req: Request, res: Response) => {
  const { provider, key, baseUrl, groupId, enabled } = req.body || {};
  
  if (!provider || !key) {
    res.status(400).json({ error: 'provider and key are required' });
    return;
  }

  const id = `${provider}-${Date.now()}`;
  apiKeysCache[id] = {
    provider: String(provider),
    key: String(key),
    baseUrl: baseUrl || '',
    groupId: groupId || '',
    createdAt: new Date().toISOString(),
    enabled: enabled !== false
  };

  saveKeys();
  
  res.json({ 
    success: true, 
    id, 
    message: `API key for ${provider} saved successfully` 
  });
});

// Update key
router.put('/:id', (req: Request, res: Response) => {
  const id = String(req.params.id || '');
  const { key, baseUrl, groupId, enabled } = req.body || {};
  
  if (!apiKeysCache[id]) {
    res.status(404).json({ error: 'API key not found' });
    return;
  }

  if (key) apiKeysCache[id].key = key;
  if (baseUrl !== undefined) apiKeysCache[id].baseUrl = baseUrl;
  if (groupId !== undefined) apiKeysCache[id].groupId = groupId;
  if (enabled !== undefined) apiKeysCache[id].enabled = enabled;

  saveKeys();
  
  res.json({ success: true, message: 'API key updated' });
});

// Delete key
router.delete('/:id', (req: Request, res: Response) => {
  const id = String(req.params.id || '');
  
  if (!apiKeysCache[id]) {
    res.status(404).json({ error: 'API key not found' });
    return;
  }

  delete apiKeysCache[id];
  saveKeys();
  
  res.json({ success: true, message: 'API key deleted successfully' });
});

// Get credentials for AI Factory
export function getAICredentials() {
  const credentials: any = {};
  
  for (const record of Object.values(apiKeysCache)) {
    if (!record.enabled) continue;
    
    switch (record.provider) {
      case 'claude':
        credentials.anthropicApiKey = record.key;
        break;
      case 'openai':
        credentials.openaiApiKey = record.key;
        break;
      case 'moonshot':
        credentials.moonshotApiKey = record.key;
        if (record.baseUrl) credentials.moonshotBaseUrl = record.baseUrl;
        break;
      case 'glm':
        credentials.glmApiKey = record.key;
        if (record.baseUrl) credentials.glmBaseUrl = record.baseUrl;
        break;
      case 'minimax':
        credentials.minimaxApiKey = record.key;
        if (record.groupId) credentials.minimaxGroupId = record.groupId;
        if (record.baseUrl) credentials.minimaxBaseUrl = record.baseUrl;
        break;
      case 'ollama':
        credentials.ollamaBaseUrl = record.baseUrl || 'http://localhost:11434';
        break;
    }
  }
  
  return credentials;
}

export default router;
