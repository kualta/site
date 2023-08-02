import { PropsWithChildren } from "react";

export const MetaButton = (props: PropsWithChildren) => {
  return (
    <div className="w-8 h-8 flex items-center justify-center rounded-md dark:shadow-dark-text/50 shadow-md bg-lit-bg dark:bg-dark-secondary m-4">
      {props.children}
    </div>
  );
};
