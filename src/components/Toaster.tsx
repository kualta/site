import { Toaster as HotToaster } from "react-hot-toast";

export function Toaster() {
  return (
    <HotToaster
      toastOptions={{
        // react-hot-toast paints its own white card under the class; the class is the card
        style: { background: "transparent", color: "inherit", boxShadow: "none", padding: 0 },
        className:
          "min-w-0 rounded-xl bg-background px-3 py-2.5 text-sm text-foreground shadow-md ring-1 ring-primary/10",
      }}
    />
  );
}
