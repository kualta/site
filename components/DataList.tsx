import { roboto_mono } from './Fonts';
import React from 'react';

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
                        href={project.link}
                        key={project.link}
                        className="group decoration-slate-200 decoration-1 underline-offset-4 w-fit"
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
