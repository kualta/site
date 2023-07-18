import fs from "fs";
import path from "path";

function PagesList({ pages }) {
  return (
    <div>
      <h1>Available Pages:</h1>
      <ul>
        {pages.map((page) => (
          <li key={page}>{page}</li>
        ))}
      </ul>
    </div>
  );
}

function ApisList({ apis }) {
  return (
    <div>
      <h1>Available APIs:</h1>
      <ul>
        {apis.map((api) => (
          <li key={api}>{api}</li>
        ))}
      </ul>
    </div>
  );
}

export default function page() {
  const pagesDirectory = path.join(process.cwd(), "app");
  const apiDirectory = path.join(process.cwd(), "app/api");

  const pages = fs
    .readdirSync(pagesDirectory)
    .map((file) => `/${file.replace(/\.js$/, "")}`);

  const apis = fs
    .readdirSync(apiDirectory)
    .map((file) => `/api/${file.replace(/\.js$/, "")}`);

  return (
    <>
      <PagesList pages={pages} />
      <ApisList apis={apis} />
    </>
  );
}

// export const getStaticProps = async () => {
//   return {
//     props: {
//       initialPages: null,
//       initialApis: null,
//       fetchPagesAndApis: true,
//     },
//   };
// };
