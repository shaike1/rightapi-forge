import { Router, Request, Response } from "express";

const router = Router();

interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: "monitoring" | "security" | "deployment" | "database" | "networking" | "custom";
  tags: string[];
  downloads: number;
  rating: number;
  ratingCount: number;
  installed: boolean;
  price: "free" | "premium";
  script?: string;
  createdAt: string;
  updatedAt: string;
}

interface Review {
  id: string;
  skillId: string;
  author: string;
  rating: number;
  comment: string;
  createdAt: string;
}

const skillsStore: Map<string, Skill> = new Map([
  ["skill-001", {
    id: "skill-001", name: "Disk Space Monitor", description: "Monitor disk usage and alert when above threshold",
    version: "1.2.0", author: "itops-team", category: "monitoring", tags: ["disk", "storage", "alert"],
    downloads: 1240, rating: 4.7, ratingCount: 89, installed: true, price: "free",
    createdAt: "2026-01-10T00:00:00Z", updatedAt: "2026-02-15T00:00:00Z"
  }],
  ["skill-002", {
    id: "skill-002", name: "SSL Certificate Checker", description: "Auto-renew SSL certs and alert on expiry",
    version: "2.0.1", author: "security-bot", category: "security", tags: ["ssl", "certificate", "security"],
    downloads: 876, rating: 4.9, ratingCount: 64, installed: false, price: "free",
    createdAt: "2026-01-20T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z"
  }],
  ["skill-003", {
    id: "skill-003", name: "Blue-Green Deployer", description: "Zero-downtime deployments with automatic rollback",
    version: "3.1.0", author: "deploy-guild", category: "deployment", tags: ["deploy", "kubernetes", "docker"],
    downloads: 2103, rating: 4.6, ratingCount: 152, installed: false, price: "premium",
    createdAt: "2025-12-01T00:00:00Z", updatedAt: "2026-02-28T00:00:00Z"
  }],
  ["skill-004", {
    id: "skill-004", name: "DB Query Optimizer", description: "Analyze slow queries and suggest indexes",
    version: "1.0.3", author: "dbmaster", category: "database", tags: ["mysql", "postgres", "performance"],
    downloads: 540, rating: 4.3, ratingCount: 38, installed: false, price: "free",
    createdAt: "2026-02-05T00:00:00Z", updatedAt: "2026-03-05T00:00:00Z"
  }],
  ["skill-005", {
    id: "skill-005", name: "Network Topology Scanner", description: "Auto-discover and map network devices",
    version: "1.5.2", author: "netops", category: "networking", tags: ["network", "discovery", "topology"],
    downloads: 318, rating: 4.1, ratingCount: 27, installed: true, price: "free",
    createdAt: "2026-02-10T00:00:00Z", updatedAt: "2026-03-08T00:00:00Z"
  }]
]);

const reviewsStore: Map<string, Review[]> = new Map();

function generateId(): string {
  return Math.random().toString(36).substr(2, 9);
}

// GET all skills (with optional filters)
router.get("/skills", (req: Request, res: Response) => {
  let skills = Array.from(skillsStore.values());
  const { category, tag, installed, q } = req.query;
  if (category) skills = skills.filter(s => s.category === category);
  if (tag) skills = skills.filter(s => s.tags.includes(tag as string));
  if (installed !== undefined) skills = skills.filter(s => s.installed === (installed === "true"));
  if (q) {
    const query = (q as string).toLowerCase();
    skills = skills.filter(s => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query));
  }
  skills.sort((a, b) => b.downloads - a.downloads);
  res.json({ skills, total: skills.length });
});

// GET single skill
router.get("/skills/:id", (req: Request, res: Response) => {
  const skill = skillsStore.get(req.params.id);
  if (!skill) return res.status(404).json({ error: "Skill not found" });
  res.json(skill);
});

// POST install skill
router.post("/skills/:id/install", (req: Request, res: Response) => {
  const skill = skillsStore.get(req.params.id);
  if (!skill) return res.status(404).json({ error: "Skill not found" });
  skill.installed = true;
  skill.downloads++;
  res.json({ success: true, skill });
});

// POST uninstall skill
router.post("/skills/:id/uninstall", (req: Request, res: Response) => {
  const skill = skillsStore.get(req.params.id);
  if (!skill) return res.status(404).json({ error: "Skill not found" });
  skill.installed = false;
  res.json({ success: true, skill });
});

// POST publish new skill
router.post("/skills", (req: Request, res: Response) => {
  const skill: Skill = {
    id: "skill-" + generateId(),
    downloads: 0, rating: 0, ratingCount: 0, installed: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...req.body
  };
  skillsStore.set(skill.id, skill);
  res.status(201).json(skill);
});

// POST add review
router.post("/skills/:id/reviews", (req: Request, res: Response) => {
  const skill = skillsStore.get(req.params.id);
  if (!skill) return res.status(404).json({ error: "Skill not found" });
  const review: Review = {
    id: generateId(), skillId: req.params.id, createdAt: new Date().toISOString(), ...req.body
  };
  const existing = reviewsStore.get(req.params.id) || [];
  existing.push(review);
  reviewsStore.set(req.params.id, existing);
  // recalc rating
  const total = existing.reduce((sum, r) => sum + r.rating, 0);
  skill.rating = Math.round((total / existing.length) * 10) / 10;
  skill.ratingCount = existing.length;
  res.status(201).json(review);
});

// GET reviews for skill
router.get("/skills/:id/reviews", (req: Request, res: Response) => {
  res.json(reviewsStore.get(req.params.id) || []);
});

// GET marketplace stats
router.get("/stats", (_req: Request, res: Response) => {
  const skills = Array.from(skillsStore.values());
  res.json({
    totalSkills: skills.length,
    installedSkills: skills.filter(s => s.installed).length,
    totalDownloads: skills.reduce((sum, s) => sum + s.downloads, 0),
    categories: [...new Set(skills.map(s => s.category))],
    topRated: skills.sort((a, b) => b.rating - a.rating).slice(0, 3).map(s => ({ id: s.id, name: s.name, rating: s.rating }))
  });
});

export default router;
