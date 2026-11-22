/** Words that change in place, as wide as the widest of everything they can say, so nothing beside them moves. */
export default function PublisherSteady({ children, among }: { children: string; among: readonly string[] }) {
  return (
    <span className="publisher-steady" data-among={among.join("\n")}>
      {children}
    </span>
  );
}
