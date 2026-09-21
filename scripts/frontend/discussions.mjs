import { benchmarks, categories, workspace } from './fixtures.mjs';

export function discussionFixture(path, body, state) {
    state.discussionPosts ??= [{ ID: 801, parentID: null, categoryID: 1, categoryName: 'Language models', contextID: 1,
        contextValues: { budget: 'standard' }, text: 'General knowledge is useful, but practical tasks deserve more weight.',
        authorName: 'Community member', createdAt: '2026-09-08T01:00:00Z', isOwn: false, upvotes: 8, downvotes: 1, replyCount: 0,
        myVote: 0, mentions: [{ benchmarkID: 101, conditionID: 1, label: 'General knowledge' }] }];
    if (path === '/api/search_discussion_benchmarks') return { benchmarks: benchmarks.filter(item => item.name.toLowerCase().includes(body.query.toLowerCase())) };
    if (path === '/api/get_discussion_summary') return { count: state.discussionPosts.filter(post => post.parentID === null).length };
    if (path === '/api/create_discussion_post') {
        const ID = 801 + state.discussionPosts.length;
        state.discussionPosts.unshift({ ...state.discussionPosts[0], ID, text: body.text, parentID: body.parentID,
            authorName: 'Preview account', isOwn: true, upvotes: 0, downvotes: 0, myVote: 0,
            mentions: body.mentions.map(mention => ({ ...mention, label: benchmarks.find(item => item.conditionID === mention.conditionID).name })) });
        return { ID, threadID: body.parentID ?? ID };
    }
    if (path === '/api/delete_discussion_post') {
        const post = state.discussionPosts.find(post => post.ID === body.postID);
        if (!post?.isOwn) throw new Error('discussion_delete_forbidden');
        post.isDeleted = true; post.text = ''; post.mentions = []; post.upvotes = post.downvotes = 0;
        return { postID: post.ID, deleted: true };
    }
    if (path === '/api/vote_discussion') {
        const post = state.discussionPosts.find(post => post.ID === body.postID);
        post.upvotes -= Number(post.myVote === 1); post.downvotes -= Number(post.myVote === -1);
        post.myVote = body.value;
        post.upvotes += Number(post.myVote === 1); post.downvotes += Number(post.myVote === -1);
        return {};
    }
    if (path === '/api/get_discussion') {
        let posts = state.discussionPosts.filter(post => body.threadID ? post.parentID === body.threadID : post.parentID === null);
        posts = posts.filter(post => !post.isDeleted || state.discussionPosts.some(reply => reply.parentID === post.ID && !reply.isDeleted));
        if (body.benchmarkID) posts = posts.filter(post => post.mentions.some(mention => mention.benchmarkID === body.benchmarkID));
        return { context: workspace(state, body).context, categories: [categories[0], ...categories[0].children],
            contexts: [{ ID: 1, values: { budget: 'standard' } }], authenticated: state.authenticated,
            root: body.threadID ? state.discussionPosts.find(post => post.ID === body.threadID) : null,
            posts, total: posts.length, hasMore: false };
    }
    if (path === '/api/get_reported_discussion') return state.discussionPosts.find(post => post.ID === body.postID);
    return null;
}
