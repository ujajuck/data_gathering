// 설정 화면(§7 Settings · §6 GET /settings · GET /normalization-presets): 읽기 전용 카드(렌더 서버 · Reader · 한도 · 작업 공간 —
// 절대 경로가 보여도 되는 유일한 화면) + 정규화 프리셋 표. 사용자 접근 토큰은 없다(메인 API는 인증하지 않는다).
import { Fragment } from "react";
import { State, useData } from "./client";
import type { NormalizationPreset, Page, SettingsResponse } from "./types";
import { Chip, Heading } from "./ui";

// 한도·설정 키의 한글 이름(모르는 키는 키 그대로).
const LIMIT_LABELS: Record<string, string> = {
  render_queue: "렌더 큐 상한",
  render_concurrency: "렌더 동시 실행",
  render_lru_mb: "렌더 메모리 캐시(MB)",
  render_cache_mb: "렌더 디스크 캐시(MB)",
  body_mb: "요청 본문 상한(MB)",
  page_limit: "목록 페이지 상한",
  window_rows: "렌더 창 행 상한",
  window_cols: "렌더 창 열 상한",
  max_rows: "렌더 행 상한",
  max_cols: "렌더 열 상한",
  max_cells: "렌더 셀 상한",
  max_bytes_mb: "렌더 직렬화 상한(MB)",
  reader_timeout_s: "Reader 시간 제한(초)",
  wait_max_s: "작업 대기 상한(초)",
  version: "API 버전",
  principal: "실행 계정",
  engine_version: "엔진 버전",
  renderer_version: "렌더러 버전",
};
// 카드가 직접 그리는 최상위 키(나머지는 '작업 공간' 카드에 붙는다).
const KNOWN_KEYS = new Set(["workspace", "render", "reader", "reader_factory", "limits", "paths"]);

const labelOf = (key: string) => LIMIT_LABELS[key] || key;
// `drm.magics`는 계약(§6)상 개수다. 옛 서버가 원문 목록을 보내도 화면은 개수로만 말한다.
const magicCount = (value: unknown): number => (Array.isArray(value) ? value.length : typeof value === "number" ? value : 0);
const text = (value: unknown) => (value === null || value === undefined || value === "" ? "-" : typeof value === "object" ? JSON.stringify(value) : String(value));

export default function Settings() {
  const settings = useData<SettingsResponse>("/settings");
  const presets = useData<Page<NormalizationPreset> | NormalizationPreset[]>("/normalization-presets");
  const presetItems = Array.isArray(presets.data) ? presets.data : presets.data?.items ?? [];
  const extras = settings.data ? Object.entries(settings.data).filter(([key]) => !KNOWN_KEYS.has(key)) : [];
  return (
    <>
      <Heading title="설정" description="서버 설정은 읽기 전용입니다. 값을 바꾸려면 서버 환경 변수를 수정하고 다시 시작합니다." />
      <State resource={settings} />
      {settings.data && <SettingsCards data={settings.data} extras={extras} />}
      <section className="app-card" aria-label="정규화 프리셋">
        <div className="app-card-head">
          <h2>정규화 프리셋</h2>
          <span className="app-muted app-small">파싱 규칙의 value_spec.normalization에서 이름으로 참조합니다.</span>
        </div>
        <State resource={presets} empty="프리셋이 없습니다." isEmpty={!presets.loading && !presets.error && presetItems.length === 0} />
        {presetItems.length > 0 && (
          <div className="app-table-wrap">
            <table className="app-table" aria-label="정규화 프리셋 목록">
              <thead>
                <tr>
                  <th scope="col">이름</th>
                  <th scope="col">키</th>
                  <th scope="col">정의</th>
                </tr>
              </thead>
              <tbody>
                {presetItems.map((p) => (
                  <tr key={p.id}>
                    <td>{p.label}</td>
                    <td>
                      <code>{p.id}</code>
                    </td>
                    <td className="app-wrap">
                      <code>{JSON.stringify(p.normalization)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function SettingsCards({ data, extras }: { data: SettingsResponse; extras: [string, unknown][] }) {
  const render = data.render || { mode: "-", url: null };
  const limits = Object.entries(data.limits || {});
  const reader = data.reader || { factory: (data.reader_factory as string | null) ?? null };
  const drm = reader.drm;
  // 연결 여부는 서버의 drm.available이 정한다. drm 블록을 주지 않는 서버에서는 어댑터 설정 유무로 읽는다 —
  // 어댑터 이름을 보여 주면서 칩만 '연결 안 됨'이라고 말하지 않게.
  const connected = drm?.available ?? !!reader.factory;
  const paths = Object.entries(data.paths || {});
  return (
    <div className="app-settings-grid">
      <section className="app-card" aria-label="렌더 서버">
        <h2>렌더 서버</h2>
        <dl className="app-kv">
          <dt>모드</dt>
          <dd>
            <Chip kind={render.mode === "http" ? "blue" : "muted"}>{render.mode === "http" ? "외부 서버(HTTP)" : render.mode === "inprocess" ? "내장(in-process)" : text(render.mode)}</Chip>
          </dd>
          <dt>URL</dt>
          <dd>{render.url || "사용 안 함"}</dd>
          <dt>렌더러 버전</dt>
          <dd>{text(render.renderer_version ?? data.renderer_version)}</dd>
        </dl>
      </section>
      <section className="app-card" aria-label="Reader">
        <div className="app-card-head">
          <h2>Reader</h2>
          <Chip kind={connected ? "ok" : "muted"}>{connected ? "연결됨" : "연결 안 됨"}</Chip>
        </div>
        <dl className="app-kv">
          <dt>보안 읽기 어댑터</dt>
          <dd>{reader.factory || "연결 안 됨"}</dd>
          {reader.revision !== undefined && reader.revision !== null && (
            <>
              <dt>어댑터 버전</dt>
              <dd>{text(reader.revision)}</dd>
            </>
          )}
          {reader.timeout_seconds !== undefined && (
            <>
              <dt>열기 시간 제한(초)</dt>
              <dd>{text(reader.timeout_seconds)}</dd>
            </>
          )}
          {reader.memory_mb !== undefined && (
            <>
              <dt>메모리 상한(MB)</dt>
              <dd>{text(reader.memory_mb)}</dd>
            </>
          )}
          {drm && (
            <>
              <dt>해제본 임시 폴더</dt>
              <dd>{drm.temp_dir_ok ? <Chip kind="ok">정상</Chip> : <Chip kind="err">작업 공간 안(위험)</Chip>}</dd>
              <dt>해제 캐시 유지(초)</dt>
              <dd>{text(drm.ttl_seconds)}</dd>
              <dt>해제본 캐시(MB)</dt>
              <dd>{text(drm.cache_mb)}</dd>
              {/* §6은 개수(`magics: n`)다 — 원문 목록은 `python -m schema drm-probe --json`이 돌려준다. */}
              <dt>등록된 보호 문서 시그니처</dt>
              <dd>{magicCount(drm.magics)}개</dd>
            </>
          )}
        </dl>
        {/* 무엇을 설정해야 하는지는 어댑터가 없을 때만 안내한다 — 연결돼 있는데 설정하라고 하면 카드가 스스로와 어긋난다. */}
        {!connected && (
          <p className="app-muted app-small">보호된 문서를 읽으려면 서버에 SCHEMA_READER_FACTORY를 설정하고 python -m schema drm-probe로 확인하세요.</p>
        )}
        <p className="app-muted app-small">이 서버는 기본으로 127.0.0.1에만 열립니다.</p>
      </section>
      <section className="app-card" aria-label="한도">
        <h2>한도</h2>
        {limits.length === 0 ? (
          <p className="app-muted">설정된 한도가 없습니다.</p>
        ) : (
          <dl className="app-kv">
            {limits.map(([key, value]) => (
              <Fragment key={key}>
                <dt>{labelOf(key)}</dt>
                <dd>{text(value)}</dd>
              </Fragment>
            ))}
          </dl>
        )}
      </section>
      <section className="app-card" aria-label="작업 공간">
        <h2>작업 공간</h2>
        <dl className="app-kv">
          <dt>경로</dt>
          <dd>
            <code>{data.workspace || "-"}</code>
          </dd>
          {paths.map(([key, value]) => (
            <Fragment key={key}>
              <dt>{labelOf(key)}</dt>
              <dd>
                <code>{text(value)}</code>
              </dd>
            </Fragment>
          ))}
          {extras.map(([key, value]) => (
            <Fragment key={key}>
              <dt>{labelOf(key)}</dt>
              <dd>{text(value)}</dd>
            </Fragment>
          ))}
        </dl>
      </section>
    </div>
  );
}
