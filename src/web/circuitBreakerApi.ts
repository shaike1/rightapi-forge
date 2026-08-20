// Circuit-breaker state API.
//
//   GET  /api/skills/circuit-breakers              — list every breaker that
//                                                    has seen at least one
//                                                    failure (CLOSED + clean
//                                                    breakers are omitted)
//   POST /api/skills/circuit-breakers/:skillId/reset
//                                                  — operator override; closes
//                                                    a tripped breaker

import express from 'express';
import type { SkillManager } from '../skills/SkillManager.js';

export interface CircuitBreakerApiDeps {
  skillManager: SkillManager;
}

export function createCircuitBreakerRouter(deps: CircuitBreakerApiDeps): express.Router {
  const router = express.Router();
  const { skillManager } = deps;

  router.get('/skills/circuit-breakers', (_req, res) => {
    const active = skillManager.listCircuitBreakers();
    res.json({ count: active.length, breakers: active });
  });

  router.post('/skills/circuit-breakers/:skillId/reset', express.json(), (req, res) => {
    const skillId = req.params.skillId;
    if (!skillId) { res.status(400).json({ error: 'skillId is required' }); return; }
    skillManager.resetCircuitBreaker(skillId);
    const after = skillManager.circuitBreakers.getState(skillId);
    res.json({ skillId, state: after });
  });

  return router;
}
