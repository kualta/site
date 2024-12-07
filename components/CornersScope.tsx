export const CornersScope = ({
  top_left = true,
  top_right = true,
  bottom_left = true,
  bottom_right = true,
  className = "",
}: { top_left?: boolean; top_right?: boolean; bottom_left?: boolean; bottom_right?: boolean; className?: string }) => {
  return (
    <>
      {top_left && <div className={`absolute top-0 left-0 m-4 p-4 rounded-tl-lg border-t-2 border-l-2 ${className}`} />}
      {top_right && (
        <div className={`absolute top-0 right-0 m-4 p-4 rounded-tr-lg border-t-2 border-r-2 ${className}`} />
      )}
      {bottom_left && (
        <div className={`absolute bottom-0 left-0 m-4 p-4 rounded-bl-lg border-b-2 border-l-2 ${className}`} />
      )}

      {bottom_right && (
        <div className={`absolute bottom-0 right-0 m-4 p-4 rounded-br-lg border-b-2 border-r-2 ${className}`} />
      )}
    </>
  );
};
