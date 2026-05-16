import { Toaster as HotToaster } from "react-hot-toast";

export function Toaster() {
  return (
    <HotToaster
      toastOptions={{
        className:
          "p-3 min-w-0 rounded-xl bg-secondary dark:bg-dark-secondary drop-shadow-md transition duration-100 border-2 border-secondary dark:border-dark-secondary hover:dark:border-dark-primary hover:border-primary text-text dark:text-dark-text",
      }}
    />
  );
}
