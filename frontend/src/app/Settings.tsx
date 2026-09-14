// 설정 화면(§7 Settings · §6 GET /settings · GET /normalization-presets): 읽기 전용 카드(렌더 서버 · Reader · 한도 · 작업 공간 —
// 절대 경로가 보여도 되는 유일한 화면) + 정규화 프리셋 표 + 서버 접근 토큰(localStorage 'schema.token').
import { Fragment, useState } from "react";
import type { FormEvent } from "react";
import { State, TOKEN_KEY, getToken, invalidateCache, setToken, useData, useToast } from "./client";
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
};
const KNOWN_KEYS = new Set(["workspace", "render", "reader_factory", "limits"]);

const labelOf = (key: string) => LIMIT_LABELS[key] || key;
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
      <TokenCard />
    </>
  );
}

function SettingsCards({ data, extras }: { data: SettingsResponse; extras: [string, unknown][] }) {
  const render = data.render || { mode: "-", url: null };
  const limits = Object.entries(data.limits || {});
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
          <dd>{text(render.renderer_version)}</dd>
        </dl>
      </section>
      <section className="app-card" aria-label="Reader">
        <h2>Reader</h2>
        <dl className="app-kv">
          <dt>Reader factory</dt>
          <dd>{data.reader_factory || "기본(XLSX)"}</dd>
        </dl>
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

// 서버 접근 토큰: 이 브라우저(localStorage 'schema.token')에만 저장된다. 저장·삭제 뒤 응답 캐시를 비운다.
function TokenCard() {
  const { notify } = useToast();
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(() => !!getToken());
  function submit(e: FormEvent) {
    e.preventDefault();
    const next = value.trim();
    if (!next) return;
    setToken(next);
    invalidateCache();
    setSaved(true);
    setValue("");
    notify("서버 접근 토큰을 저장했습니다.");
  }
  function clear() {
    setToken("");
    invalidateCache();
    setSaved(false);
    notify("서버 접근 토큰을 지웠습니다.");
  }
  return (
    <section className="app-card" aria-label="서버 접근">
      <div className="app-card-head">
        <h2>서버 접근</h2>
        <Chip kind={saved ? "ok" : "muted"}>{saved ? "토큰 저장됨" : "토큰 없음"}</Chip>
      </div>
      <form className="app-form" onSubmit={submit}>
        <label>
          서버 접근 토큰
          <input type="password" autoComplete="off" value={value} placeholder={saved ? "새 토큰으로 바꾸려면 입력" : "서버에 설정된 접근 토큰"} onChange={(e) => setValue(e.target.value)} />
        </label>
        <p className="app-muted app-small">
          이 브라우저에만 저장됩니다(키 <code>{TOKEN_KEY}</code>). 서버로는 요청 헤더로만 전달됩니다.
        </p>
        <div className="app-inline">
          <button type="submit" className="primary" disabled={!value.trim()}>
            저장
          </button>
          <button type="button" className="secondary" disabled={!saved} onClick={clear}>
            지우기
          </button>
        </div>
      </form>
    </section>
  );
}
