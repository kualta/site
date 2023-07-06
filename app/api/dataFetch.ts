import { PrismaClient } from "@prisma/client";
import getPostMetadata from "components/PostMetadata";
import { NextResponse } from "next/server";

export const prisma = new PrismaClient();

export async function getAllContacts() {
	const contacts = await prisma.contact.findMany({
		orderBy: {
			platform: "asc",
		},
	});

	return NextResponse.json(contacts);
}

export async function getAllPosts() {
	const posts = getPostMetadata();
	const linkablePosts = posts.map((post) => ({
		name: post.title,
		description: post.description,
		link: `https://kualta.dev/blog/${post.filename}`,
	}));
	return NextResponse.json(linkablePosts);
}

export async function getAllProjects() {
	const projects = await prisma.project.findMany({
		orderBy: {
			relevance: "desc",
		},
	});

	return NextResponse.json(projects);
}
