import express, { type Request, type Response } from 'express';
import { CredentialVault } from '../security/CredentialVault.js';

const router = express.Router();

// Use the existing CredentialVault with a master key
const VAULT_KEY = process.env.CREDENTIAL_MASTER_KEY || process.env.SECRET_MASTER_KEY || 'default-master-key-change-this-in-production';
const VAULT_PATH = process.env.CREDENTIAL_VAULT_PATH || '/data/itops-agents/credentials.vault.json';
const credentialVault = new CredentialVault(VAULT_PATH, VAULT_KEY);

// Get all credentials (by listing all agent IDs and collecting)
router.get('/', async (_req: Request, res: Response) => {
  try {
    // Since there's no listAll method, we'll collect from all known agents
    const knownAgents = ['alice', 'bob', 'eve', 'charlie', 'diana', 'director'];
    const allCredentials: any[] = [];
    
    for (const agentId of knownAgents) {
      const agentCreds = credentialVault.listByAgent(agentId);
      allCredentials.push(...agentCreds);
    }
    
    res.json({ success: true, credentials: allCredentials });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to load credentials',
      details: (error as Error).message 
    });
  }
});

// Get credentials for specific agent
router.get('/agent/:agentId', async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const credentials = credentialVault.listByAgent(agentId as string);
    
    res.json({ success: true, credentials });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to load credentials',
      details: (error as Error).message 
    });
  }
});

// Add credential
router.post('/', async (req: Request, res: Response) => {
  try {
    const { agentId, name, scope, secret } = req.body;
    
    if (!agentId || !name || !scope || !secret) {
      res.status(400).json({ 
        error: 'agentId, name, scope, and secret are required' 
      });
      return;
    }
    
    const result = credentialVault.upsert({
      agentId: agentId as string,
      name: name as string,
      scope: scope as string,
      secret: secret as string
    });
    
    res.json({ 
      success: true, 
      id: result.id,
      message: `Credential for ${name} added successfully` 
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to add credential',
      details: (error as Error).message 
    });
  }
});

// Update credential
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, scope, secret } = req.body;
    
    if (!name && !scope && !secret) {
      res.status(400).json({ 
        error: 'At least one field (name, scope, or secret) is required' 
      });
      return;
    }
    
    // Get the current credential by trying to resolve secret
    const currentSecret = credentialVault.resolveSecret(id as string);
    
    if (currentSecret === null) {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }
    
    // Since upsert needs agentId and we don't have it, we need to find it
    // For now, we'll require all fields for update
    if (!req.body.agentId) {
      res.status(400).json({ 
        error: 'agentId is required for update' 
      });
      return;
    }
    
    const result = credentialVault.upsert({
      id: id as string,
      agentId: req.body.agentId as string,
      name: name || 'updated',
      scope: scope || 'updated',
      secret: secret || currentSecret
    });
    
    res.json({ success: true, message: 'Credential updated successfully', result });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to update credential',
      details: (error as Error).message 
    });
  }
});

// Delete credential
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const deleted = credentialVault.delete(id as string);
    
    if (deleted) {
      res.json({ success: true, message: 'Credential deleted successfully' });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to delete credential',
      details: (error as Error).message 
    });
  }
});

export default router;
