import { PropsWithChildren } from "react";

export const Card = (props: PropsWithChildren) => {
  return (
    <div
      className="p-2 min-w-0 rounded-2xl bg-secondary dark:bg-dark-secondary drop-shadow-md  
                transition duration-100 border-2 border-secondary dark:border-dark-secondary 
                hover:dark:border-dark-primary hover:border-primary"
    >
      {props.children}
    </div>
  );
};
