import { readFileSync } from "node:fs";
import { Lexicons, jsonToLex } from "@atproto/lexicon";
import { schemas } from "@atproto/api";

const lexicons = new Lexicons(schemas);
for (const name of ["site.standard.publication", "site.standard.document"]) {
  lexicons.add(JSON.parse(readFileSync(new URL(`../lexicons/${name}.json`, import.meta.url), "utf8")));
}

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
    throw new Error("Article exceeds the portable record size budget; split the article before publishing");
  }
}
