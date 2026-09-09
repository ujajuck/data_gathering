import { useState } from "react";
import { api, useNavigation } from "./client";
import type { Row } from "./client";

export default function ConceptEditor({
  kg,
  concept,
}: {
  kg: string;
  concept: Row;
}) {
  const { go, changed } = useNavigation();
  const [name, setName] = useState(concept.name),
    [definition, setDefinition] = useState(concept.definition || "");
  const [aliases, setAliases] = useState(""),
    [status, setStatus] = useState(concept.status || "active");
  const [relation, setRelation] = useState(""),
    [kind, setKind] = useState("related"),
    [remove, setRemove] = useState(false);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError("");
    try {
      const edge = relation
        ? [{ from: concept.concept_id, to: relation, type: kind }]
        : [];
      const result = await api(
        `/kg/${kg}/concepts/${encodeURIComponent(concept.concept_id)}/revisions`,
        {
          expected_revision_id: kg,
          name,
          definition,
          status,
          aliases: aliases
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          add_relations: remove ? [] : edge,
          remove_relations: remove ? edge : [],
        },
      );
      changed();
      go({ kg: result.kg_revision_id, concept: concept.concept_id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="v2-details">
      <summary>개념 편집 · 동의어 추가</summary>
      <p>
        새 KG 버전으로 발행합니다. 기존 템플릿과 추출 결과는 참조하던 KG 버전을
        유지합니다.
      </p>
      <label>
        개념명
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        정의
        <textarea
          value={definition}
          onChange={(e) => setDefinition(e.target.value)}
        />
      </label>
      <label>
        추가할 동의어 · 줄마다 하나
        <textarea
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
        />
      </label>
      <label>
        개념 상태
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">사용</option>
          <option value="deprecated">폐기</option>
        </select>
      </label>
      <label>
        관계 대상 개념 ID
        <input value={relation} onChange={(e) => setRelation(e.target.value)} />
      </label>
      <label>
        관계 종류
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="related">관련</option>
          <option value="parent_of">하위 개념</option>
        </select>
      </label>
      <label className="v2-check">
        <input
          type="checkbox"
          checked={remove}
          onChange={(e) => setRemove(e.target.checked)}
        />
        선택한 관계 제거
      </label>
      <button disabled={busy} onClick={save}>
        개념 수정 발행
      </button>
      <p className="v2-error" role="alert">
        {error}
      </p>
    </details>
  );
}
