const SocialsLink = (link: string, name: string) => {
    return <div>
        <a href={link} key={link}>{name}</a>
    </div>;
};

export default SocialsLink;
