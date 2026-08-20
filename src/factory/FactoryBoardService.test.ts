import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FactoryBoardService } from "./FactoryBoardService.js";

function withTempBoard(markdown: string, run: (boardPath: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-board-"));
  const boardPath = path.join(tempDir, "PROJECT_KANBAN.md");
  fs.writeFileSync(boardPath, markdown, "utf8");
  try {
    run(boardPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("FactoryBoardService parses canonical headings", () => {
  const markdown = `
# Board
### Done
- Delivered feature A
### In Progress
- Working feature B
### Next
- Plan feature C
### Backlog
- Future feature D
`;
  withTempBoard(markdown, (boardPath) => {
    const snapshot = new FactoryBoardService(boardPath).getSnapshot();
    assert.equal(snapshot.columns.done.length, 1);
    assert.equal(snapshot.columns.inProgress.length, 1);
    assert.equal(snapshot.columns.next.length, 1);
    assert.equal(snapshot.columns.backlog.length, 1);
  });
});

test("FactoryBoardService tolerates bullet-prefixed headings", () => {
  const markdown = `
# Board
-### Done
- Delivered feature A
-### In Progress
- Working feature B
### Next
- Plan feature C
-### Backlog
- Future feature D
`;
  withTempBoard(markdown, (boardPath) => {
    const snapshot = new FactoryBoardService(boardPath).getSnapshot();
    assert.equal(snapshot.columns.done.length, 1);
    assert.equal(snapshot.columns.inProgress.length, 1);
    assert.equal(snapshot.columns.next.length, 1);
    assert.equal(snapshot.columns.backlog.length, 1);
  });
});
