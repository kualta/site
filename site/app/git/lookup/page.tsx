import { roboto_mono } from "components/Fonts";
import Link from "next/link";
import { FiFileText, FiGitBranch, FiStar } from "react-icons/fi";

async function GitPage() {
	const repos = await (
		await fetch("https://api.github.com/users/kualta/repos")
	).json();
	const repoList = repos.map((repo: any) => {
		const created_at = new Date(repo.created_at).toLocaleDateString();
		const updated_at = new Date(repo.updated_at).toLocaleDateString();
		const star_color = repo.stargazers_count > 0 ? "white" : "gray";
		const branch_color = repo.forks_count > 0 ? "white" : "gray";

		return (
			<li key={repo.id} className={roboto_mono.className}>
				<a href={repo.html_url} title={repo.full_name}>
					{repo.name}
				</a>
				<span> - {repo.description}</span>
				<div className="flex flex-col p-4 text-sm gap-x-4">
					<div className="flex gap-1 content-center items-center place-content-start">
						<FiStar size={15} color={star_color} />
						<span>{repo.stargazers_count}</span>
						<FiGitBranch size={15} color={branch_color} />
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

	const username = "kualta";
	return (
		<div className="prose prose-invert">
			<div
				className={`p-4 flex flex-wrap flex-row place-content-evenly align-middle ${roboto_mono.className}`}
			>
				<h2 className="">TODO {username}</h2>
				<h3>
					<Link href={"/"}>{"Home >"}</Link>
				</h3>
			</div>
			<ol>{repoList}</ol>
		</div>
	);
}

export default GitPage;
