/** 注册 @/ 别名加载器（Node --import 用） */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./alias-loader.mjs', pathToFileURL('./scripts/'))
