"use client";
import { motion } from "framer-motion";
import { PropsWithChildren } from "react";

export const SlideIn = (props: PropsWithChildren) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: -48 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -48 }}
      transition={{
        duration: 0.5,
        ease: "easeOut",
      }}
    >
      {props.children}
    </motion.div>
  );
};
