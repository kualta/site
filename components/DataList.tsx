import { roboto_mono } from './fonts';

interface Data {
    name: string;
    description: string;
    link: string;
}

const DataList = (props: { list: Data[]; title: string }) => {
    return (
        <div className="">
            <h2 className={`${roboto_mono.className} font-semibold text-xl pt-8`} >
                {props.title}
            </h2>
            <div className="flex flex-col space-y-2 p-4">
                {props.list.map((project) => 
                    <a href={project.link} key={project.link} className="decoration-slate-200 hover:underline decoration-1 w-fit" >
                        <b className={roboto_mono.className}>{project.name}</b>
                        <span className="px-1">{` - `}</span>
                        <span className={roboto_mono.className}>
                            {project.description}
                        </span>
                    </a>
                )}
            </div>
        </div>
    );
};

export default DataList;
