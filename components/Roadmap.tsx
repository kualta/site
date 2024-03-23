"use client";
import React from "react";

export const TimelineItem = ({
  isActive,
  title,
  description,
  type,
}: { isActive: boolean; title: string; description: string; type: string }) => {
  const height = type === "paper" ? "h-12" : "h-24"
  return (

    <div className="grid grid-cols-[24px_1fr] items-start gap-4">
      <div
        className={`my-4 w-4 h-4 rounded-full border border-gray-200 dark:border-gray-800 ${
          isActive ? "bg-green-500 dark:bg-green-500" : "bg-gray-200 dark:bg-gray-800"
        }`}
      />
      <div className="flex flex-col justify-center placeitems-center h-full gap-1 text-sm">
        <div className={`font-medium ${isActive ? "text-green-500 dark:text-green-500" : ""}`}>{title}</div>
        {description !== "" && <div className="text-xs text-gray-500 dark:text-gray-400">{description}</div>}
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
      className={`w-0.5 mx-2 ${height} ${isActive ? "border-l" : "border-l border-gray-200 dark:border-gray-800"}`}
    />
  );
};
