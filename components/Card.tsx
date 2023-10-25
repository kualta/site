import { PropsWithChildren } from "react";

export const Card = (props: PropsWithChildren) => {
  return (
    <div
      className="p-3 min-w-0 rounded-lg bg-secondary dark:bg-dark-secondary drop-shadow-md  
                transition duration-300 hover:drop-shadow-glow-dark hover:dark:drop-shadow-glow"
    >
      {props.children}
    </div>
  );
};
