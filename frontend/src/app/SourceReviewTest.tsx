// Source Review 우측 패널(테스트 모드, §4.7): groups[]의 규칙·필드·관찰된 키·값(≤50)·개수와 errors[].
// 수정·승인·반려·이력은 없다. 행동은 닫기 · 다시 실행(호출자가 컨텍스트 줄에 둔다).
import { regionLabel } from "./client";
import type { RegionRef, TestGroup, TestResult } from "./types";
import { Chip, EmptyState } from "./ui";
import { compatibilityLabel, roleLabel } from "./sourceReviewShared";

export const TEST_TIMEOUT_CODE = "TEST_TIMEOUT";

export const isPartialResult = (result: TestResult | null | undefined) =>
  !!result?.errors?.some((error) => error.code === TEST_TIMEOUT_CODE);

export default function TestResultPanel({
  result,
  group,
  onShowRegion,
}: {
  result: TestResult;
  group: TestGroup | null;
  onShowRegion: (region: RegionRef) => void;
}) {
  const errors = result.errors || [];
  const partial = isPartialResult(result);
  const values = (group?.values || []).slice(0, 50);
  return (
    <div className="app-stack" data-testid="test-panel">
      <div className="app-inline">
        <h3 style={{ margin: 0 }}>테스트 결과</h3>
        <Chip kind={result.compatibility === "identical" ? "ok" : result.compatibility === "incompatible" ? "err" : "warn"}>
          {compatibilityLabel(result.compatibility)}
        </Chip>
        <span className="app-muted app-small">규칙 {result.groups.length}개</span>
      </div>
      {partial && (
        <div className="app-note" role="status" data-testid="partial-banner">
          시간 제한(20초)으로 일부 결과만 표시합니다. 다시 실행하면 이어서 확인할 수 있습니다.
        </div>
      )}
      {errors.filter((e) => e.code !== TEST_TIMEOUT_CODE).length > 0 && (
        <div className="app-error" role="alert">
          <ul className="app-plain-list">
            {errors
              .filter((e) => e.code !== TEST_TIMEOUT_CODE)
              .map((error, i) => (
                <li key={i}>
                  {error.rule_key ? <strong>{error.rule_key}: </strong> : null}
                  {error.message}
                  <span className="app-muted app-small"> ({error.code})</span>
                </li>
              ))}
          </ul>
        </div>
      )}
      {group ? (
        <>
          <dl className="app-kv">
            <dt>파싱 규칙</dt>
            <dd>{group.rule_key}</dd>
            <dt>필드</dt>
            <dd>
              {group.field ? (
                <>
                  <strong>{group.field.name}</strong>
                  {group.field.unit || group.field.type ? (
                    <span className="app-muted app-small"> {[group.field.type, group.field.unit].filter(Boolean).join(" · ")}</span>
                  ) : null}
                </>
              ) : (
                <span className="app-muted">미지정</span>
              )}
            </dd>
            <dt>관찰된 키</dt>
            <dd>{group.observed_key || "-"}</dd>
            <dt>값 개수</dt>
            <dd>{group.count}</dd>
            <dt>원본 위치</dt>
            <dd>
              {group.regions.length ? (
                <ul className="app-region-list">
                  {group.regions.map((region, i) => (
                    <li key={i}>
                      <button type="button" className="link" onClick={() => onShowRegion(region)} title="시트에서 보기">
                        {roleLabel(region.role)}: {regionLabel(region.sheet_name, region.range)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                "-"
              )}
            </dd>
          </dl>
          {values.length > 0 ? (
            <div className="app-table-wrap">
              <table className="app-table" aria-label="테스트 값">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">값</th>
                    <th scope="col">단위</th>
                    <th scope="col">원본 위치</th>
                  </tr>
                </thead>
                <tbody>
                  {values.map((value, i) => (
                    <tr key={i}>
                      <td className="num">{i + 1}</td>
                      <td>{value.display_text || value.value_text}</td>
                      <td>{value.unit_normalized || "-"}</td>
                      <td>
                        {value.region ? (
                          <button type="button" className="link small" onClick={() => onShowRegion(value.region!)}>
                            {regionLabel(value.region.sheet_name, value.region.range)}
                          </button>
                        ) : (
                          "-"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {group.count > values.length && (
                <p className="app-muted app-small">
                  {group.count}개 중 {values.length}개만 표시
                </p>
              )}
            </div>
          ) : (
            <EmptyState>이 규칙에서 추출된 값이 없습니다.</EmptyState>
          )}
        </>
      ) : (
        <EmptyState>결과 규칙이 없습니다. 프로파일의 시트 역할·선택자를 확인하세요.</EmptyState>
      )}
    </div>
  );
}
