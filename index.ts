import express from 'express';
import { generateApolloClient } from "@deep-foundation/hasura/client";
import { DeepClient, parseJwt } from "@deep-foundation/deeplinks/imports/client";
import http from 'http';
import { error } from 'console';

const app = express();

const GQL_URN = process.env.GQL_URN || 'localhost:3006/gql';
const GQL_SSL = process.env.GQL_SSL || 0;

const makeDeepClient = (token: string) => {
  if (!token) throw new Error('No token provided');
  const decoded = parseJwt(token);
  const linkId = decoded?.userId;
  const apolloClient = generateApolloClient({
    path: GQL_URN,
    ssl: !!+GQL_SSL,
    token,
  });
  const deepClient = new DeepClient({ apolloClient, linkId, token });
  return deepClient;
}

let discordClient;
let botPromise;

const startBot = async (deep, botToken) => {
  const conversationTypeLinkId = await deep.id("@deep-foundation/chatgpt-azure", "Conversation");
  const messageTypeLinkId = await deep.id("@deep-foundation/messaging", "Message");
  const authorTypeLinkId = await deep.id("@deep-foundation/messaging", "Author");
  const containTypeLinkId = await deep.id("@deep-foundation/core", "Contain");
  const replyTypeLinkId = await deep.id("@deep-foundation/chatgpt-azure", 'Reply');
  const messagingTreeId = await deep.id("@deep-foundation/messaging", 'messagingTree');
  const userLinkId = deep.linkId;

  const Discord = require("discord.js");
  const {ChannelType} = Discord;

  discordClient = new Discord.Client({
    intents: [
      Discord.GatewayIntentBits.DirectMessages,
      Discord.GatewayIntentBits.Guilds,
      Discord.GatewayIntentBits.GuildMessages,
      Discord.GatewayIntentBits.MessageContent,
    ],
  });

  const botListenPromise = new Promise((resolve, reject) => {
    discordClient.on('ready', () => {
      console.log(`Logged in as ${discordClient.user.tag}!`);
    });

    process.on('unhandledRejection', async (event) => {
      const eventString = JSON.stringify(event, null, 2);
      console.error('Unhandled rejection:', eventString);
      await discordClient.destroy();
      // throw new Error(`Unhandled rejection error: ${eventString}`);
    });

    discordClient.on('exit', (event) => {
      const eventString = JSON.stringify(event, null, 2);
      console.log(`Discord bot is exited:`, event);
      resolve({ existedSuccessfully: true, exitEvent: event });
    });

    discordClient.on('disconnected', (event) => {
      const eventString = JSON.stringify(event, null, 2);
      console.log(`Discord bot is disconnected:`, event);
      throw new Error(`Discord bot is disconnection error: ${eventString}`);
    });

    discordClient.on(Discord.Events.MessageCreate, async (message) => {
      const mentionPrefix = `<@${discordClient.user.id}>`;
      console.log({mentionPrefix})
      const channelManager = discordClient.channels;
      const channel = await channelManager.fetch(message.channelId)
      console.log({channel})
      const allowedChannelTypes = [ChannelType.PublicThread,ChannelType.PrivateThread]
      console.log({allowedChannelTypes})
      const isAllowedChannelType = allowedChannelTypes.includes(channel.type)
      console.log({isAllowedChannelType})
      if (message.content.includes(mentionPrefix) && !message.author.bot && isAllowedChannelType) {
        const channelName = "" + message.channel.id;
        console.log({channelName})
        let messageContent;

        if (message.reference) {
          const replyToMessageId = message.reference.messageID;
          console.log({replyToMessageId});
          const replyToMessage = await message.fetchReference();
          const replyText = replyToMessage.content;
          console.log({replyText});
          messageContent = `${replyToMessage.content}
          ---
          ${message.content}`;
        } else {
          messageContent = message.content
          console.log({messageContent})
        };

        const messageLink = {
          string: { data: { value: messageContent } },
          type_id: messageTypeLinkId
        };
        console.log({messageLink})

        const { data: [{ id: messageLinkId }] } = await deep.insert(messageLink);

        await deep.insert({
          type_id: await deep.id("@deep-foundation/chatgpt-azure-discord-bot", "MessageId"),
          from_id: messageLinkId,
          to_id: messageLinkId,
          string: {
            data: { value: '' + message.id }
          }
        });
        const { data } = await deep.select({
          type_id: conversationTypeLinkId,
          string: { value: { _eq: channelName } }
        });

        const conversationLinkId = data?.[0]?.id

        if (conversationLinkId > 0) {
          const result = await deep.select({
            tree_id: { _eq: messagingTreeId },
            link: { type_id: { _eq: messageTypeLinkId } },
            root_id: { _eq: conversationLinkId },
            self: { _eq: true }
          }, {
            table: 'tree',
            variables: { order_by: { depth: "desc" } },
            returning: `
                id
                depth
                root_id
                parent_id
                link_id
                link {
                  id
                  from_id
                  type_id
                  to_id
                  value
                  author: out (where: { type_id: { _eq: ${authorTypeLinkId}} }) { 
                    id
                    from_id
                    type_id
                    to_id
                  }
                }`
          })

          const lastMessageId = result?.data?.[0]?.link?.id || conversationLinkId;

          await deep.insert({
            type_id: replyTypeLinkId,
            from_id: messageLinkId,
            to_id: lastMessageId,
          });
        } else {
          await deep.insert({
            string: { data: { value: channelName } },
            type_id: conversationTypeLinkId,
            in: {
              data: [{
                type_id: containTypeLinkId,
                from_id: userLinkId,
              },
              {
                type_id: replyTypeLinkId,
                from_id: messageLinkId,
              }]
            }
          });
        }
      }
    });

    discordClient.login(botToken);
  });
  return await botListenPromise;
}

app.use(express.json());

app.get('/healthz', (req, res) => {
  res.json({});
});

app.post('/init', async (req, res) => {
  if (discordClient) {
    discordClient.destroy();
    if (botPromise) {
      await botPromise;
    }
  }
  const { deepToken, botToken } = req.body;
  const deep = makeDeepClient(deepToken);
  botPromise = startBot(deep, botToken);
  res.send(req.body);
});


http.createServer({ maxHeaderSize: 10*1024*1024*1024 }, app).listen(process.env.PORT);
console.log(`Listening ${process.env.PORT} port`);
