import { TimelineItem, TimelineLine } from "@/components/Roadmap";
import React from "react";

interface TimelineData {
  title: string;
  description: string;
  isActive: boolean;
  type: "phase" | "project" | "paper" | "question";
}

const Component: React.FC = () => {
  const timelineData: TimelineData[] = [
    {
      title: "Phase 0",
      description: "Ensure the stability of communication channels",
      type: "phase",
      isActive: true,
    },
    {
      title: "Ping 3.0",
      description: "decentralized social platform",
      type: "project",
      isActive: true,
    },
    {
      title: "Kunet",
      description: "mesh social network",
      type: "project",
      isActive: true,
    },
    {
      title: "Phase 1",
      description: "Build the governance infrastructure",
      type: "phase",
      isActive: true,
    },
    {
      title: "Kudao",
      description: "an open meritocratic platform",
      type: "project",
      isActive: true,
    },
    {
      title: "Phase 2",
      description: "Unite the people",
      type: "phase",
      isActive: true,
    },
    {
      title: "Black Box",
      description: "a global gaming hub",
      type: "project",
      isActive: true,
    },
    {
      title: "Black Box Meta",
      description: "A virtual gaming hub",
      type: "project",
      isActive: true,
    },
    {
      title: "Phase 3",
      description: "Unite the universe",
      type: "phase",
      isActive: true,
    },
    {
      title: "Declare the Meta State",
      description: "",
      type: "question",
      isActive: true,
    },
  ];

  return (
    <div className="grid max-w-sm mx-auto sm:max-w-md lg:max-w-2xl">
      <div className="flex flex-col place-items-center justify-center">
        <TimelineLine isActive={true} height="h-full" />
        <div className="flex flex-col w-full gap-2 items-start">
          {timelineData.map((item, index) => (
            <React.Fragment key={index}>
              <TimelineItem isActive={item.isActive} title={item.title} description={item.description} />
              {index !== timelineData.length - 1 && <TimelineLine isActive={item.isActive} height="h-24" />}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Component;
