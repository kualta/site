import { readFileSync, readdirSync } from "node:fs";
import { Lexicons, jsonToLex } from "@atproto/lexicon";
import { schemas } from "@atproto/api";

const directory = new URL("../lexicons/", import.meta.url);
const readLexicon = (file) => JSON.parse(readFileSync(new URL(file, directory), "utf8"));

export function ownLexicons() {
  return readdirSync(directory)
    .filter((file) => /^dev\.kualta\..+\.json$/.test(file))
    .sort()
    .map((file) => {
      const lexicon = readLexicon(file);
      if (`${lexicon.id}.json` !== file) throw new Error(`Lexicon id does not match its filename: ${file}`);
      return lexicon;
    });
}

const lexicons = new Lexicons(schemas);
for (const name of ["site.standard.publication", "site.standard.document"]) lexicons.add(readLexicon(`${name}.json`));
for (const lexicon of ownLexicons()) lexicons.add(lexicon);

export function validateRecord(record) {
  lexicons.assertValidRecord(record.$type, jsonToLex(record));
  if (
    record.content &&
    (record.content.$type !== "at.markpub.markdown" ||
      record.content.text?.$type !== "at.markpub.text" ||
      typeof record.content.text.markdown !== "string")
  ) {
    throw new Error("Invalid portable Markdown content");
  }
  // Leave room for DAG-CBOR framing below the AT Protocol record-size limit.
  if (Buffer.byteLength(JSON.stringify(record)) > 900_000) {
    throw new Error(`${record.$type} exceeds the portable record size budget; split it before publishing`);
  }
}
