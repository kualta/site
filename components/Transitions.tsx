"use client";
import { Transition } from "@headlessui/react";
import { PropsWithChildren } from "react";

export const FadeIn = (props: PropsWithChildren) => {
  return (
    <Transition
      show={true}
      appear={true}
      unmount={true}
      enter="transition-opacity duration-200"
      enterFrom="opacity-50"
      enterTo="opacity-100"
      leave="transition-opacity duration-200"
      leaveFrom="opacity-100"
      leaveTo="opacity-50"
      className="h-full w-full"
    >
      {props.children}
    </Transition>
  );
};

export const SlideIn = (props: PropsWithChildren) => {
  return (
    <Transition
      show={true}
      appear={true}
      unmount={true}
      className="transition-all duration-200"
      enter="transition ease duration-500 transform"
      enterFrom="opacity-0 -translate-y-12"
      enterTo="opacity-100 translate-y-0"
      leave="transition ease duration-200 transform"
      leaveFrom="opacity-100 translate-y-0"
      leaveTo="opacity-0 -translate-y-12"
    >
      {props.children}
    </Transition>
  );
};
