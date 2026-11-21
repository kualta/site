import { readFileSync, readdirSync } from "node:fs";
import { Lexicons, jsonToLex, parseLexiconDoc } from "@atproto/lexicon";
import { schemas } from "@atproto/api";

const vendored = new URL("../lexicons/", import.meta.url);
const readLexicon = (file, directory = vendored) => JSON.parse(readFileSync(new URL(file, directory), "utf8"));

export function ownLexicons(directory = vendored) {
  return readdirSync(directory)
    .filter((file) => /^dev\.kualta\..+\.json$/.test(file))
    .sort()
    .map((file) => {
      const lexicon = readLexicon(file, directory);
      if (`${lexicon.id}.json` !== file) throw new Error(`Lexicon id does not match its filename: ${file}`);
      // Lexicons.add accepts malformed definitions, and these documents are published as the public contract.
      parseLexiconDoc(lexicon);
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
