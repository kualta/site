import fs from "fs";
import Link from "next/link";
import path from "path";

function PagesList({ pages }:any) {
  return (
    <div className="">
      <ul className="gap-1 flex-col flex ml-4">
        {pages.map((page: any) => (
          <li className="hover:underline">
            <Link href={page} key={page}>
              {page}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function page() {
  const apiDirectory = path.join(process.cwd(), "app/api");
  const apis = fs.readdirSync(apiDirectory).map((file) => `/api/${file.replace(/\.js$/, "")}`);

  return (
    <>
      <h1>Available APIs</h1>
      <PagesList pages={apis} />
    </>
  );
}