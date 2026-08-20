import { Router, Request, Response } from "express";

const router = Router();

interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: "free" | "pro" | "enterprise";
  maxAgents: number;
  maxTasks: number;
  createdAt: string;
  settings: Record<string, unknown>;
}

interface Workspace {
  id: string;
  orgId: string;
  name: string;
  description: string;
  environment: "development" | "staging" | "production";
  agentIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface OrgUser {
  id: string;
  orgId: string;
  email: string;
  role: "owner" | "admin" | "member" | "viewer";
  joinedAt: string;
}

const orgsStore: Map<string, Organization> = new Map([
  ["org-1", {
    id: "org-1", name: "IT Operations", slug: "itops", plan: "enterprise",
    maxAgents: 50, maxTasks: 1000, createdAt: "2026-01-01T00:00:00Z",
    settings: { notifications: true, autoScale: true }
  }],
  ["org-2", {
    id: "org-2", name: "DevOps Team", slug: "devops", plan: "pro",
    maxAgents: 20, maxTasks: 200, createdAt: "2026-02-01T00:00:00Z",
    settings: { notifications: true, autoScale: false }
  }]
]);

const workspacesStore: Map<string, Workspace> = new Map([
  ["ws-1", {
    id: "ws-1", orgId: "org-1", name: "Production", description: "Live production environment",
    environment: "production", agentIds: ["alice", "bob", "charlie"],
    createdAt: "2026-01-05T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z"
  }],
  ["ws-2", {
    id: "ws-2", orgId: "org-1", name: "Staging", description: "Pre-production testing",
    environment: "staging", agentIds: ["diana", "eve"],
    createdAt: "2026-01-10T00:00:00Z", updatedAt: "2026-02-20T00:00:00Z"
  }],
  ["ws-3", {
    id: "ws-3", orgId: "org-2", name: "Dev Environment", description: "Development sandbox",
    environment: "development", agentIds: [],
    createdAt: "2026-02-05T00:00:00Z", updatedAt: "2026-02-05T00:00:00Z"
  }]
]);

const usersStore: Map<string, OrgUser[]> = new Map([
  ["org-1", [
    { id: "u1", orgId: "org-1", email: "shai@itops.local", role: "owner", joinedAt: "2026-01-01T00:00:00Z" },
    { id: "u2", orgId: "org-1", email: "alice@itops.local", role: "admin", joinedAt: "2026-01-05T00:00:00Z" }
  ]]
]);

function generateId(): string {
  return Math.random().toString(36).substr(2, 9);
}

// --- Organizations ---
router.get("/orgs", (_req: Request, res: Response) => {
  res.json(Array.from(orgsStore.values()));
});

router.get("/orgs/:id", (req: Request, res: Response) => {
  const org = orgsStore.get(req.params.id);
  if (!org) return res.status(404).json({ error: "Organization not found" });
  res.json(org);
});

router.post("/orgs", (req: Request, res: Response) => {
  const org: Organization = {
    id: "org-" + generateId(), createdAt: new Date().toISOString(),
    settings: {}, maxAgents: 10, maxTasks: 100, ...req.body
  };
  orgsStore.set(org.id, org);
  res.status(201).json(org);
});

router.put("/orgs/:id", (req: Request, res: Response) => {
  const org = orgsStore.get(req.params.id);
  if (!org) return res.status(404).json({ error: "Organization not found" });
  const updated = { ...org, ...req.body, id: org.id };
  orgsStore.set(org.id, updated);
  res.json(updated);
});

router.delete("/orgs/:id", (req: Request, res: Response) => {
  if (!orgsStore.delete(req.params.id)) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

// --- Workspaces ---
router.get("/orgs/:orgId/workspaces", (req: Request, res: Response) => {
  const workspaces = Array.from(workspacesStore.values()).filter(w => w.orgId === req.params.orgId);
  res.json(workspaces);
});

router.post("/orgs/:orgId/workspaces", (req: Request, res: Response) => {
  const ws: Workspace = {
    id: "ws-" + generateId(), orgId: req.params.orgId,
    agentIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...req.body
  };
  workspacesStore.set(ws.id, ws);
  res.status(201).json(ws);
});

router.put("/workspaces/:id", (req: Request, res: Response) => {
  const ws = workspacesStore.get(req.params.id);
  if (!ws) return res.status(404).json({ error: "Workspace not found" });
  const updated = { ...ws, ...req.body, id: ws.id, updatedAt: new Date().toISOString() };
  workspacesStore.set(ws.id, updated);
  res.json(updated);
});

router.delete("/workspaces/:id", (req: Request, res: Response) => {
  if (!workspacesStore.delete(req.params.id)) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

// --- Users ---
router.get("/orgs/:orgId/users", (req: Request, res: Response) => {
  res.json(usersStore.get(req.params.orgId) || []);
});

router.post("/orgs/:orgId/users", (req: Request, res: Response) => {
  const user: OrgUser = {
    id: generateId(), orgId: req.params.orgId, joinedAt: new Date().toISOString(), ...req.body
  };
  const existing = usersStore.get(req.params.orgId) || [];
  existing.push(user);
  usersStore.set(req.params.orgId, existing);
  res.status(201).json(user);
});

// --- Summary ---
router.get("/summary", (_req: Request, res: Response) => {
  const orgs = Array.from(orgsStore.values());
  const workspaces = Array.from(workspacesStore.values());
  res.json({
    organizations: orgs.length,
    workspaces: workspaces.length,
    environments: {
      production: workspaces.filter(w => w.environment === "production").length,
      staging: workspaces.filter(w => w.environment === "staging").length,
      development: workspaces.filter(w => w.environment === "development").length
    },
    plans: {
      enterprise: orgs.filter(o => o.plan === "enterprise").length,
      pro: orgs.filter(o => o.plan === "pro").length,
      free: orgs.filter(o => o.plan === "free").length
    }
  });
});

export default router;
