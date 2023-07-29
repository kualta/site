import { PropsWithChildren } from "react"

export const MetaButton = (props: PropsWithChildren) => {
  return (
    <div className="rounded w-10 h-10">
      {props.children}
    </div>
  )
}