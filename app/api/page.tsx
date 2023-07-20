import fs from "fs";
import Link from "next/link";
import path from "path";

function ApiList({ pages: apis }: any) {
  return (
    <div className="">
      <ul className="gap-2 text-sm sm:text-base flex-col flex ml-4">
        {apis.map((api: any) => (
          <li className="hover:underline font-mono">
            <Link href={api} key={api}>
              {api}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function page() {
  const apiDirectory = path.join(process.cwd(), "app/api");

  const apis = fs
    .readdirSync(apiDirectory)
    .filter((path) => !path.endsWith(".tsx"))
    .map((path) => `/api/${path}`)

  return (
    <>
      {/* <h1 className="text-bold text-md sm:text-lg">Available APIs:</h1> */}
      <ApiList pages={apis} />
    </>
  );
}
