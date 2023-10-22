"use client";
import { Transition } from "@headlessui/react";
import { PropsWithChildren } from "react";

export const FadeIn = (props: PropsWithChildren) => {
  return (
    <Transition
      show={true}
      appear={true}
      unmount={true}
      enter="transition-opacity duration-150"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-150"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
      className="h-full w-full"
    >
      {props.children}
    </Transition>
  );
};
