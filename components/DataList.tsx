import { roboto_mono } from './Fonts';

interface Data {
    name: string;
    description: string;
    link: string;
}

const DataList = (props: { list: Data[] }) => {
    return (
        <div className="">
            <div className="flex flex-col space-y-2 p-4">
                {props.list.map((project) => (
                    <a
                        className="group decoration-slate-200 decoration-1 underline-offset-4 w-fit"
                        href={project.link}
                        key={project.link}
                    >
                        <b className={`${roboto_mono.className} group-hover:underline`}>{project.name}</b>
                        <span className="px-1">{` - `}</span>
                        <span className={`${roboto_mono.className} group-hover:underline`}>{project.description}</span>
                    </a>
                ))}
            </div>
        </div>
    );
};

export default DataList;
