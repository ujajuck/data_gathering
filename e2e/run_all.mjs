// E2E 러너 — kg.db를 백업하고 시나리오를 순서대로 실행한 뒤 원복한다.
// 전제: 서버 실행 중 (python -m kg.webapp --ws domains/financier --port 8010)
// 사용: node e2e/run_all.mjs   (KG_WS / KG_BASE_URL 환경변수로 재정의)
import { execFileSync } from "child_process";
import { copyFileSync, existsSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const ws = process.env.KG_WS || join(here, "..", "domains", "financier");
const db = join(ws, "data", "kg", "kg.db");
const bak = db + ".e2e-bak";

if (!existsSync(db)) {
  console.error(`kg.db가 없습니다: ${db} — KG_WS를 확인하세요`);
  process.exit(2);
}
copyFileSync(db, bak);
console.log(`kg.db 백업 → ${bak}\n`);

let failed = 0;
const scripts = readdirSync(here).filter((f) => /^\d\d_.*\.mjs$/.test(f)).sort();
for (const s of scripts) {
  console.log(`── ${s} ──`);
  try {
    execFileSync(process.execPath, [join(here, s)],
                 { stdio: "inherit", env: process.env });
  } catch {
    failed += 1;
  }
  console.log("");
}

copyFileSync(bak, db);
console.log(`kg.db 원복 완료 (서버 재시작 없이 다음 요청부터 반영)`);
console.log(failed ? `\n${failed}개 시나리오 실패` : "\n전체 시나리오 통과");
process.exit(failed ? 1 : 0);
