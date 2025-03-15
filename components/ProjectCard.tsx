"use client";
import { Project } from "@prisma/client";
import { Card } from "./Card";
import { useState } from "react";
import { FiCopy, FiExternalLink, FiGithub } from "react-icons/fi";
import { MdOutlineExpandLess, MdOutlineExpandMore } from "react-icons/md";
import { motion, AnimatePresence } from "framer-motion";

export const ProjectCard = ({ project, expandAll }: { project: Project; expandAll: boolean }) => {
  const [expanded, setExpanded] = useState(expandAll);
  const statusStyles =
    project.status === "complete" || project.status === "ongoing" ? "text-text dark:text-dark-text" : "text-secondary";
  const dateText = new Date(project.date).toLocaleDateString();

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      className="relative"
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
      >
        <Card>
          <div className={"min-w-0 w-full text-sm group"}>
            <div className={"text-base -mt-2 flex group items-center gap-2 place-items-center justify-center min-w-0"}>
              <b className="text-lg min-w-fit">{project.name}</b>
              {project.full_name && (
                <span className="hidden sm:flex text-xs overflow-hidden text-elipsis truncate">
                  {"(aka"}
                  &nbsp;
                  <p>{project.full_name}</p>
                  {")"}
                </span>
              )}
              <p className=" truncate ">- {project.description}</p>
              {project.link && (
                <a
                  target="_blank"
                  rel="noreferrer"
                  href={project.link}
                  className="text-secondary-text hover:scale-110 hover:text-text dark:hover:text-dark-text"
                  onClick={(e) => e.stopPropagation()}
                >
                  <FiExternalLink />
                </a>
              )}
              {project.git_link && (
                <>
                  <a
                    target="_blank"
                    rel="noreferrer"
                    href={project.git_link}
                    className="text-secondary-text hover:scale-110 hover:text-text dark:hover:text-dark-text"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <FiGithub />
                  </a>
                </>
              )}
              <span className="grow shrink" />
              <p
                className={`text-xs hidden sm:flex border px-2 pb-0.5 rounded-lg text-secondary-text leading-4 -mb-1 ${statusStyles}`}
              >
                {project.status}
              </p>
              <motion.button
                type="button"
                className="text-secondary-text hover:text-text dark:hover:text-dark-text -mb-1"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
              >
                {expanded || expandAll ? <MdOutlineExpandLess /> : <MdOutlineExpandMore />}
              </motion.button>
            </div>
            <AnimatePresence initial={false}>
              {(expanded || expandAll) && (
                <motion.div
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: "auto", marginTop: 8 }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  transition={{
                    height: { duration: 0.3, ease: "easeInOut" },
                    opacity: { duration: 0.2, delay: 0.1 },
                    marginTop: { duration: 0.2 }
                  }}
                  style={{ overflow: "hidden" }}
                >
                  <div className="flex flex-col gap-2">
                    <span className="gap-2 flex sm:hidden items-center">
                      <b>status: </b>

                      <p className={`border px-2 pb-0.5 rounded-lg text-secondary-text leading-4 ${statusStyles}`}>
                        {project.status}
                      </p>
                    </span>
                    <span className="gap-2 flex">
                      <b>date: </b>
                      <p>{dateText}</p>
                    </span>
                    <span className="gap-2 flex items-center">
                      <b>tech: </b>
                      <p className="flex flex-wrap gap-2">
                        <span className="border px-2 py-0.5 rounded-lg">{project.language}</span>
                        {project.tech_stack.map((v: string) => (
                          <span key={v} className="border px-2 py-0.5 rounded-lg">
                            {v}
                          </span>
                        ))}
                      </p>
                    </span>
                    <span>
                      {project.git_link && (
                        <span className="flex ">
                          <b>git: </b>
                          &nbsp;
                          <a href={project.git_link}>{project.git_link}</a>
                          <motion.button
                            type="button"
                            className="text-secondary-text hover:text-text dark:hover:text-dark-text active:text-primary dark:active:text-dark-primary p-1"
                            onClick={(event) => {
                              event.stopPropagation();
                              navigator.clipboard.writeText(project.git_link);
                            }}
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.95 }}
                          >
                            <FiCopy size={15} />
                          </motion.button>
                        </span>
                      )}
                    </span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </Card>
      </motion.div>
    </div>
  );
};
