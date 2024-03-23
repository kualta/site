"use client";
import React from "react";
import { RiCircleLine } from "react-icons/ri";
import { HiOutlineDocumentText } from "react-icons/hi";
import { TbFlagQuestion } from "react-icons/tb";

export const TimelineItem = ({
  isActive,
  title,
  description,
  type,
}: { isActive: boolean; title: string; description: string; type: string }) => {
  const text_size = type === "phase" ? "text-xl" : "text-sm";
  const description_size = type === "phase" ? "text-md" : "text-xs";
  const icon = getIconByType(type);
  return (
    <div className="grid grid-cols-[24px_1fr] items-start gap-4">
      <div className={"my-2 w-6 h-6 flex place-items-center justify-center"}>{icon}</div>
      {/* <TimelineLine isActive={isActive} height="h-full" /> */}
      <div className={`flex flex-col justify-center placeitems-center h-full gap-1 ${text_size}`}>
        <div className={`font-medium ${isActive ? "text-green-500 dark:text-green-500" : ""}`}>{title}</div>
        {description !== "" && (
          <div className={`text-gray-500 dark:text-gray-400 ${description_size}`}> {description}</div>
        )}
      </div>
    </div>
  );
};

export const TimelineLine = ({
  isActive,
  height,
}: {
  isActive: boolean;
  height: string;
}) => {
  return (
    <div
      className={`w-0.5 ml-3 ${height} ${isActive ? "border-l" : "border-l border-gray-200 dark:border-gray-800"}`}
    />
  );
};
function getIconByType(type: string) {
  switch (type) {
    case "phase":
      return <RiCircleLine size="26" />;
    case "paper":
      return <HiOutlineDocumentText className="ml-1" size="20" strokeWidth={1.5} />;
    case "question":
      return <TbFlagQuestion size="24" />;
    default:
      return <RiCircleLine size="18" />;
  }
}
