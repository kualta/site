import { PropsWithChildren } from "react";

export const Card = (props: PropsWithChildren) => {
  return (
    <div className="p-3 min-w-fit rounded-lg bg-secondary dark:bg-dark-secondary drop-shadow-md border border-primary dark:border-dark-primary">
      {props.children}
    </div>
  );
};
