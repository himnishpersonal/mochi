type NoteBlock = { id: string; noteId: string; section: string; text: string; citationIds: number[]; noteSources?: string[]; ordinal: number };
type Source = { id: number; startMs: number };

const noteText = (text: string) => text.split("\n").map(line => line.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, "").trim()).filter(Boolean).join("\n");
const timestamp = (ms: number) => `${Math.floor(ms / 60_000).toString().padStart(2, "0")}:${Math.floor(ms / 1000 % 60).toString().padStart(2, "0")}`;

export default function EnhancedNotes({ blocks, segments, onCitation, onEdit }: {
  blocks: NoteBlock[]; segments: Source[]; onCitation: (id: number) => void; onEdit: (block: NoteBlock) => void;
}) {
  const sections = new Map<string, NoteBlock[]>();
  for (const block of blocks) sections.set(block.section, [...(sections.get(block.section) || []), block]);
  return <div className="enhanced-notes">{Array.from(sections, ([section, items]) => <section className="enhanced-section" key={section} aria-label={section}>
    <h3>{section}</h3>
    <ul>{items.map(block => <li key={block.id}>
      <span className="enhanced-note-text" role="textbox" aria-label={`Edit ${section.toLowerCase()} note ${blocks.indexOf(block) + 1}`} aria-multiline="true"
        contentEditable="plaintext-only" suppressContentEditableWarning
        onBlur={event => {
          const text = (event.currentTarget.innerText || event.currentTarget.textContent || "").trim();
          if (!text) { event.currentTarget.textContent = noteText(block.text); return; }
          if (text !== noteText(block.text)) onEdit({ ...block, text });
        }}
        onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.textContent = noteText(block.text); event.currentTarget.blur(); } }}
      >{noteText(block.text)}</span>
      {(block.citationIds.length > 0 || !!block.noteSources?.length) && <span className="enhanced-sources" aria-label="Supporting sources">{block.citationIds.map(id => {
        const source = segments.find(segment => segment.id === id);
        const label = source ? timestamp(source.startMs) : "Source";
        return <button key={id} className="enhanced-source" title={`View supporting transcript${source ? ` at ${label}` : ""}`} aria-label={`Open transcript ${source ? `at ${label}` : `source ${id}`}`} onClick={() => onCitation(id)}>{label}</button>;
      })}{!!block.noteSources?.length && <span className="enhanced-source" title={block.noteSources.join("\n")} tabIndex={0} aria-label={`From your notes: ${block.noteSources.join("; ")}`}>Your notes</span>}</span>}
    </li>)}</ul>
  </section>)}</div>;
}
