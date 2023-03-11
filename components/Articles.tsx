import { Article } from '../site/app/api/articles/route';
import { roboto_mono } from './fonts';

const Articles = (props: { articles: Article[] }) => {
    return (
        <div className="flex flex-col space-y-4 py-8">
            {props.articles.map((project) => (
                <a href={project.link} key={project.link} className="">
                    <b className={roboto_mono.className}>{project.name}</b>
                    {` - `}
                    <span className={roboto_mono.className}>
                        {project.description}
                    </span>
                </a>
            ))}
        </div>
    );
};

export default Articles;
