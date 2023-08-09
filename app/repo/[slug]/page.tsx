import { FiFileText, FiGitBranch, FiStar } from "react-icons/fi";

async function page({ params }: any) {
  const username = params.slug;
  const repos = await (await fetch(`https://api.github.com/users/${username}/repos`)).json();

  const repoList = repos.map((repo: any) => {
    const created_at = new Date(repo.created_at).toLocaleDateString();
    const updated_at = new Date(repo.updated_at).toLocaleDateString();

    return (
      <li key={repo.id}>
        <a href={repo.html_url} title={repo.full_name}>
          {repo.name}
        </a>
        <span> - {repo.description}</span>
        <div className="flex flex-col p-4 text-sm gap-x-4">
          <div className="flex gap-1 content-center items-center place-content-start">
            <FiStar size={15} />
            <span>{repo.stargazers_count}</span>
            <FiGitBranch size={15} />
            <span>{repo.forks_count}</span>
            <FiFileText size={15} />
            <span>{repo.language}</span>
          </div>
          <div>created at: {created_at}</div>
          <div>updated at: {updated_at}</div>
        </div>
      </li>
    );
  });

  return (
    <div className="mx-auto max-w-2xl">
      <div className="prose dark:prose-invert">
        <div className={"p-4 flex flex-wrap flex-row place-content-evenly align-middle"}>
          <h2 className="font-light">
            github repos for user:
            <b className="pl-4">{username}</b>
          </h2>
        </div>
        <ol>{repoList}</ol>
      </div>
    </div>
  );
}

export default page;
