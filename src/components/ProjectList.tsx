import { Badge } from "@flow-industries/ui/components/badge";
import { buttonVariants } from "@flow-industries/ui/components/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@flow-industries/ui/components/item";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@flow-industries/ui/components/tooltip";
import { Archive, ExternalLink, Github, Gitlab } from "lucide-react";
import type { ReactElement } from "react";
import type { Project } from "@/types";

/** the order the groups are listed in; each status is also its heading */
const STATUSES = ["ongoing", "complete", "archived"] as const;

const iconLink = buttonVariants({
  variant: "ghost",
  size: "icon-sm",
  className: "text-muted-foreground hover:text-foreground",
});

function Hint({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** an archived project has nowhere live to link to, so its badge takes the website's place */
function StatusLink({ project, name }: { project: Project; name: string }) {
  if (project.status === "archived") {
    return (
      <Hint label="archived">
        <span className={iconLink} role="img" aria-label="archived">
          <Archive aria-hidden="true" />
        </span>
      </Hint>
    );
  }
  if (!project.link) return null;
  return (
    <Hint label="website">
      <a href={project.link} target="_blank" rel="noreferrer" className={iconLink} aria-label={`${name} website`}>
        <ExternalLink aria-hidden="true" />
      </a>
    </Hint>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const name = project.full_name || project.name;
  const isGitlab = project.git_link?.includes("gitlab.com");
  const host = isGitlab ? "GitLab" : "GitHub";
  return (
    <Item className="-mx-3 w-auto" render={<li />}>
      <ItemContent className="min-w-0">
        <ItemTitle className="text-base">
          <a
            href={project.link || project.git_link}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-4 hover:underline"
          >
            {name}
          </a>
          {project.language && (
            <span className="font-mono text-xs font-normal text-muted-foreground">{project.language}</span>
          )}
        </ItemTitle>
        <ItemDescription className="line-clamp-1">{project.description}</ItemDescription>
      </ItemContent>
      <ItemActions className="gap-0.5">
        {project.git_link && (
          <Hint label={host}>
            <a href={project.git_link} target="_blank" rel="noreferrer" className={iconLink} aria-label={`${name} on ${host}`}>
              {isGitlab ? <Gitlab aria-hidden="true" /> : <Github aria-hidden="true" />}
            </a>
          </Hint>
        )}
        <StatusLink project={project} name={name} />
      </ItemActions>
    </Item>
  );
}

export function ProjectList({ projects }: { projects: Project[] }) {
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-10">
        {STATUSES.map((status) => {
          const group = projects.filter((project) => project.status === status);
          if (group.length === 0) return null;
          return (
            <section key={status} aria-labelledby={`projects-${status}`} className="flex flex-col gap-2">
              <h2 id={`projects-${status}`} className="flex items-center gap-2 text-sm font-[550] tracking-wide text-muted-foreground">
                {status}
                {/* what is under way now is the one thing on the page marked in pink */}
                <Badge variant={status === "ongoing" ? "brand" : "secondary"} className="tabular-nums">
                  {group.length}
                </Badge>
              </h2>
              <ul className="flex flex-col gap-1">
                {group.map((project) => (
                  <ProjectRow key={project.id} project={project} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
